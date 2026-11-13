import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteMcp, type RemoteToolResult } from '@inkbox/sdk/remote-mcp'
import { afterEach, expect, it } from 'vitest'
import type { RoutedEvent } from '../src/routing.js'
import type { InkboxRuntime } from '../src/runtime.js'
import { replyState, terminalReply } from '../src/terminal-reply.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-terminal-'))
  roots.push(stateDir)
  const remote = new RemoteMcp({
    apiKey: 'synthetic',
    baseUrl: 'https://example.test',
    identity: 'synthetic',
    journalPath: join(stateDir, 'calls'),
  })
  const runtime = {
    config: { stateDir },
    getClient: async () => ({ _apiKey: 'synthetic', _baseUrl: 'https://example.test' }),
    getIdentity: async () => ({ id: 'synthetic' }),
  } as unknown as InkboxRuntime
  const event: RoutedEvent = {
    eventId: 'event',
    routeKey: 'route',
    channel: 'sms',
    sender: '+15550000001',
    group: false,
    context: '',
    content: '',
    replyText: '',
    target: { channel: 'sms', to: '+15550000001' },
  }
  return { remote, runtime, event }
}

it('reconciles the same terminal operation and keeps unrelated sources independent', async () => {
  const { remote, runtime, event } = await setup()
  const calls: string[] = []
  const execute = async (
    _name: string,
    _args: Record<string, unknown>,
    operation: string,
    _journal: string,
    submit: () => void,
  ): Promise<RemoteToolResult> => {
    submit()
    calls.push(operation)
    if (calls.length === 1) throw new Error('Synthetic lost response')
    return {
      content: [],
      structuredContent: { message_id: 'accepted', delivery_status: 'sent', recipients: ['+15550000001'] },
    }
  }
  await expect(terminalReply(remote, runtime, event, 'Finished', () => {}, execute)).rejects.toThrow(
    'lost response',
  )
  expect(await replyState(runtime, event)).toBe('uncertain')
  await expect(terminalReply(remote, runtime, event, 'Changed', () => {}, execute)).rejects.toThrow()
  await terminalReply(remote, runtime, event, 'Finished', () => {}, execute)
  expect(calls[0]).toBe(calls[1])
  expect(await replyState(runtime, event)).toBe('accepted')
  await terminalReply(remote, runtime, event, 'Finished', () => {}, execute)
  expect(calls).toHaveLength(2)
  expect(await replyState(runtime, { ...event, eventId: 'another' })).toBe('none')
})

it('permits a different operation after rejection before execution', async () => {
  const { remote, runtime, event } = await setup()
  const rejected = async (): Promise<RemoteToolResult> => ({ content: [], isError: true })
  await terminalReply(remote, runtime, event, 'First', () => {}, rejected)
  expect(await replyState(runtime, event)).toBe('none')
  const accepted = async (
    _name: string,
    _args: Record<string, unknown>,
    _operation: string,
    _journal: string,
    submit: () => void,
  ): Promise<RemoteToolResult> => {
    submit()
    return {
      content: [],
      structuredContent: { message_id: 'accepted', delivery_status: 'sent', recipients: ['+15550000001'] },
    }
  }
  await terminalReply(remote, runtime, event, 'Second', () => {}, accepted)
  expect(await replyState(runtime, event)).toBe('accepted')
})

it.each([
  { delivery_status: 'blocked_spam_filter' },
  { delivery_status: 'sending_failed' },
  { message_id: '' },
  { recipients: ['+15550000002'] },
  { error: 'synthetic_failure' },
])('requires canonical accepted SMS receipt %j', async (changes) => {
  const { remote, runtime, event } = await setup()
  const execute = async (
    _name: string,
    _args: Record<string, unknown>,
    _operation: string,
    _path: string,
    submit: () => void | Promise<void>,
  ): Promise<RemoteToolResult> => {
    await submit()
    return {
      content: [],
      structuredContent: {
        message_id: 'accepted',
        recipients: ['+15550000001'],
        delivery_status: 'queued',
        ...changes,
      },
    }
  }
  await expect(terminalReply(remote, runtime, event, 'Finished', () => {}, execute)).rejects.toThrow()
  expect(await replyState(runtime, event)).toBe('uncertain')
})
