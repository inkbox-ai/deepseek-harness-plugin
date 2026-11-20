import { chmod, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  INBOUND_BODY_MAX_BYTES,
  INBOUND_STDERR_TAIL_BYTES,
  InboundStore,
  inboundRoutedEvent,
  parseInbound,
  runInboundScript,
  truncateInboundBody,
} from '../src/inbound.js'

it('parses only complete inbound events', () => {
  const data = {
    event_id: 'inbev_1',
    delivery_id: 'inbdlv_1',
    source: { id: 'inbsrc_1', name: 'payments', instructions: null },
    handler: { type: 'script', command: 'true' },
    request: { headers: { 'x-a': '1' }, body: 'AA==', body_encoding: 'base64' },
  }
  expect(parseInbound({ data })).toEqual({
    eventId: 'inbev_1',
    deliveryId: 'inbdlv_1',
    sourceId: 'inbsrc_1',
    sourceName: 'payments',
    handler: { type: 'script', command: 'true' },
    headers: { 'x-a': '1' },
    body: 'AA==',
    bodyEncoding: 'base64',
  })
  expect(parseInbound({ data: { ...data, delivery_id: undefined } })).toBeUndefined()
  expect(parseInbound({ data: { ...data, handler: { type: 'script' } } })).toBeUndefined()
  expect(parseInbound({ data: { ...data, event_id: undefined } })).toBeUndefined()
})

it('truncates bodies over 64 KiB on a character boundary', () => {
  const body = `${'a'.repeat(INBOUND_BODY_MAX_BYTES - 1)}é tail`
  expect(truncateInboundBody(body)).toBe(`${'a'.repeat(INBOUND_BODY_MAX_BYTES - 1)}\n(truncated)`)
  expect(truncateInboundBody('a'.repeat(INBOUND_BODY_MAX_BYTES))).toBe('a'.repeat(INBOUND_BODY_MAX_BYTES))
})

it('kills a timed-out script and everything it started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkbox-inbound-'))
  const started = Date.now()
  const result = await runInboundScript('sleep 30 & sleep 30', dir, '', 200)
  expect(result).toEqual({ ok: false, error: 'Timed out after 0.2 s' })
  expect(Date.now() - started).toBeLessThan(5_000)
})

it('reports a non-zero exit with the stderr tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkbox-inbound-'))
  expect(await runInboundScript('cat; echo failed >&2; exit 2', dir, 'in')).toEqual({
    ok: false,
    error: 'failed',
  })
  expect(await runInboundScript('cat', dir, 'echoed')).toEqual({ ok: true, stdout: 'echoed' })
})

it('keeps at most 64 KiB of stdout and a 4 KiB stderr tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkbox-inbound-'))
  const flood = 'head -c 5000000 /dev/zero | tr "\\0" a'
  const output = await runInboundScript(flood, dir, '')
  expect(output.ok && output.stdout).toBe(`${'a'.repeat(INBOUND_BODY_MAX_BYTES)}\n(truncated)`)
  const failed = await runInboundScript(`${flood} >&2; echo END >&2; exit 1`, dir, '')
  expect(failed.ok).toBe(false)
  if (!failed.ok) {
    expect(Buffer.byteLength(failed.error)).toBeLessThanOrEqual(INBOUND_STDERR_TAIL_BYTES)
    expect(failed.error.endsWith('END')).toBe(true)
  }
})

it('routes inbound turns by source id, not display name', () => {
  const event = parseInbound({
    data: {
      event_id: 'inbev_1',
      delivery_id: 'inbdlv_1',
      source: { id: 'inbsrc_1', name: 'build[1]' },
      handler: { type: 'agent' },
      request: { body: '' },
    },
  })
  if (!event) throw new Error('unparsed')
  const routed = inboundRoutedEvent('evt', event, 'body')
  expect(routed.routeKey).toBe('inbound:inbsrc_1')
  expect(routed.context).toContain('"build[1]"')
})

it('counts unreadable records separately from malformed ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkbox-inbound-'))
  const store = new InboundStore(dir)
  const event = parseInbound({
    data: {
      event_id: 'inbev_1',
      delivery_id: 'inbdlv_1',
      source: { id: 'inbsrc_1', name: 'payments' },
      handler: { type: 'agent' },
      request: { body: '' },
    },
  })
  if (!event) throw new Error('unparsed')
  await store.save({ trackingId: 'evt', event, attempts: 0, dueAt: 0 })
  await writeFile(join(dir, 'broken.json'), '{')
  const [record = ''] = (await readdir(dir)).filter((name) => name !== 'broken.json')
  await chmod(join(dir, record), 0)
  expect(await store.load()).toEqual({ items: [], unreadable: 1 })
  await chmod(join(dir, record), 0o600)
  const loaded = await store.load()
  expect(loaded.unreadable).toBe(0)
  expect(loaded.items.map((item) => item.event.deliveryId)).toEqual(['inbdlv_1'])
  expect(await readdir(dir)).toContain('broken.json')
})
