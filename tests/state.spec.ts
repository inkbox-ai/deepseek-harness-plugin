import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../src/state.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'inkbox-state-'))
  roots.push(root)
  const value = new StateStore(join(root, 'gateway-state.json'))
  await value.initialize()
  return value
}

describe('durable gateway state', () => {
  it('creates a private versioned state document with a stable routing key', async () => {
    const value = await store()
    const first = value.snapshot()
    expect(first.version).toBe(1)
    expect(first.routingKey.length).toBeGreaterThan(32)
    const resumed = new StateStore(value.path)
    await resumed.initialize()
    expect(resumed.snapshot().routingKey).toBe(first.routingKey)
  })

  it('serializes concurrent dedup mutations without losing events', async () => {
    const value = await store()
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        value.mutate((state) => {
          state.seen[`evt-${index}`] = Date.now()
        }),
      ),
    )
    expect(Object.keys(value.snapshot().seen)).toHaveLength(20)
  })

  it('persists routes, created state, seen events, and reply ledger', async () => {
    const value = await store()
    const now = Date.now()
    await value.mutate((state) => {
      state.routes.contact = { sessionId: 'inkbox-session', created: true }
      state.seen.event = now
      state.replied.event = now
      state.deliveries.delivery = {
        eventIds: ['event'],
        target: { channel: 'email', to: 'person@example.test', subject: 'Re: Test' },
        response: 'response',
        attempts: 1,
        nextAttemptAt: now,
      }
    })
    const disk = JSON.parse(await readFile(value.path, 'utf8'))
    expect(disk).toMatchObject({
      routes: { contact: { created: true } },
      seen: { event: now },
      replied: { event: now },
      deliveries: { delivery: { eventIds: ['event'], attempts: 1 } },
    })
  })

  it('returns mutation results from the committed transaction', async () => {
    const value = await store()
    expect(
      await value.mutate((state) => {
        state.seen.one = 1
        return 'accepted'
      }),
    ).toBe('accepted')
  })

  it('drops malformed pending deliveries while preserving valid state', async () => {
    const value = await store()
    const document = JSON.parse(await readFile(value.path, 'utf8'))
    document.deliveries = { broken: { response: 42 } }
    await writeFile(value.path, JSON.stringify(document))
    const resumed = new StateStore(value.path)
    await resumed.initialize()
    expect(resumed.snapshot().deliveries).toEqual({})
  })
})
