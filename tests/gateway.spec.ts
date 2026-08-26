import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentIdentity, Inkbox } from '@inkbox/sdk'
import type { TunnelListener } from '@inkbox/sdk/tunnels/connect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { Gateway, isSilentResponse } from '../src/gateway.js'
import type { InkboxRuntime } from '../src/runtime.js'

const tunnel = vi.hoisted(() => ({
  connected: true,
  handler: undefined as ((request: Request) => Promise<Response>) | undefined,
  wsHandler: undefined as ((socket: unknown) => Promise<void>) | undefined,
  verify: true,
  aclose: vi.fn(async () => {}),
  connect: vi.fn(),
}))

const liveCall = vi.hoisted(() => ({
  authenticated: true,
  connect: vi.fn(async () => ({ close: vi.fn(), send: vi.fn() })),
  bridge: vi.fn(async (_ws, _openai, _meta, callbacks) => {
    await callbacks.consult('Check the calendar', [{ party: 'caller', text: 'Are we free?' }])
    await callbacks.ended(
      [{ party: 'caller', text: 'Please send a confirmation.' }],
      [{ action: 'Send confirmation', details: 'Email it' }],
    )
  }),
}))

vi.mock('@inkbox/sdk', () => ({
  verifyWebhook: vi.fn(() => tunnel.verify),
}))

vi.mock('@inkbox/sdk/tunnels/connect', () => ({
  connect: tunnel.connect,
}))

vi.mock('../src/realtime.js', () => ({
  authenticateCallWebSocket: vi.fn(() => liveCall.authenticated),
  awaitRealtimeReady: vi.fn(async () => ({ ok: true, detail: 'ready' })),
  connectOpenAIRealtime: liveCall.connect,
  loadCallMeta: vi.fn(async () => ({
    callId: 'call-live-1',
    contactId: 'contact-live-1',
    direction: 'outbound',
    remotePhoneNumber: '+15550000001',
    agentHandle: 'deepseek-agent',
  })),
  runRealtimeBridge: liveCall.bridge,
}))

interface Harness {
  gateway: Gateway
  identity: {
    sendEmail: ReturnType<typeof vi.fn>
    sendText: ReturnType<typeof vi.fn>
    sendIMessage: ReturnType<typeof vi.fn>
  }
  subscriptions: {
    list: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  stateDir: string
}

async function harness(
  batchWindowMs = 0,
  voiceStack: ResolvedConfig['voiceStack'] = 'inkbox_voice_ai',
): Promise<Harness> {
  const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-gateway-'))
  const subscriptions = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ signingKey: null })),
    update: vi.fn(async () => ({})),
  }
  const client = { webhooks: { subscriptions } }
  const identity = {
    id: 'identity-1',
    agentHandle: 'deepseek-agent',
    mailbox: { id: 'mailbox-1' },
    phoneNumber: { id: 'phone-1' },
    sendEmail: vi.fn(async () => ({ id: 'mail-1' })),
    sendText: vi.fn(async () => ({ id: 'text-1' })),
    sendIMessage: vi.fn(async () => ({ id: 'imessage-1' })),
  }
  const runtime = {
    getClient: vi.fn(async () => client as unknown as Inkbox),
    getIdentity: vi.fn(async () => identity as unknown as AgentIdentity),
    resolveSigningKey: vi.fn(async () => 'test-signing-key'),
    resolveRealtimeKey: vi.fn(async () => 'sk-realtime'),
  } as unknown as InkboxRuntime
  const ctx = {
    credentials: { set: vi.fn(async () => {}) },
  } as unknown as Context
  const config: ResolvedConfig = {
    enabled: true,
    workspace: stateDir,
    agentHandle: 'deepseek-agent',
    credentialRef: 'INKBOX_API_KEY',
    signingKeyRef: 'INKBOX_WEBHOOK_SIGNING_KEY',
    githubWebhookSecretRef: 'INKBOX_WEBHOOK_SECRET_GITHUB',
    stateDir,
    batchWindowMs,
    permissionTimeoutMs: 2_000,
    externalEvents: false,
    voiceEnabled: true,
    voiceStack,
    realtimeCredentialRef: 'INKBOX_REALTIME_API_KEY',
    realtimeModel: 'gpt-realtime-2',
    realtimeVoice: 'cedar',
  }
  const gateway = new Gateway(ctx, runtime, config, {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })
  await gateway.start()
  return { gateway, identity, subscriptions, stateDir }
}

function email(id: string, body = 'Hello from email'): Request {
  return new Request('https://agent.example.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': 'signed' },
    body: JSON.stringify({
      id,
      event_type: 'message.received',
      data: {
        message: {
          from_address: 'person@example.test',
          subject: 'Question',
          body,
          thread_id: 'thread-1',
          message_id: `<${id}@example.test>`,
        },
        contacts: [{ id: 'contact-1', address: 'person@example.test' }],
      },
    }),
  })
}

function callEnded(id: string): Request {
  return new Request('https://agent.example.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': 'signed' },
    body: JSON.stringify({
      id: `event-${id}`,
      event_type: 'call.ended',
      data: { call: { id, remote_phone_number: '+15550000001' } },
    }),
  })
}

beforeEach(() => {
  tunnel.connected = true
  tunnel.handler = undefined
  tunnel.wsHandler = undefined
  tunnel.verify = true
  tunnel.aclose.mockClear()
  tunnel.connect.mockReset()
  tunnel.connect.mockImplementation(async (_client, options) => {
    tunnel.handler = options.handler
    tunnel.wsHandler = options.wsHandler
    options.onStatus?.('connected')
    return {
      publicUrl: 'https://agent.example.test',
      get isConnected() {
        return tunnel.connected
      },
      wait: () => new Promise<void>(() => {}),
      aclose: tunnel.aclose,
    } as unknown as TunnelListener
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('gateway lifecycle and delivery', () => {
  it('connects the tunnel and reconciles every configured channel', async () => {
    const { gateway, subscriptions, stateDir } = await harness()
    expect(gateway.status()).toMatchObject({ ready: true, connected: true, identity: 'deepseek-agent' })
    expect(subscriptions.create).toHaveBeenCalledTimes(5)
    await gateway.close()
    expect(tunnel.aclose).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(stateDir, 'status.json'), 'utf8'))).toMatchObject({
      ready: false,
    })
  })

  it('attaches authenticated Realtime calls to the same contact-scoped Harness agent', async () => {
    const { gateway } = await harness(0, 'openai_realtime')
    const run = vi
      .spyOn(gateway.agents, 'run')
      .mockResolvedValueOnce('Calendar checked')
      .mockResolvedValueOnce('[SILENT]')
    await tunnel.wsHandler?.({
      url: 'wss://agent.example.test/phone/media/ws',
      headers: new Map(),
    })
    expect(liveCall.connect).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-realtime', model: 'gpt-realtime-2', voice: 'cedar' }),
      expect.objectContaining({ callId: 'call-live-1' }),
    )
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0]?.[0]).toBe('contact:contact-live-1')
    expect(run.mock.calls[0]?.[1]).toContain('Caller request: Check the calendar')
    expect(run.mock.calls[1]?.[1]).toContain('Send confirmation')
    expect((await gateway.handleRequest(callEnded('call-live-1'))).status).toBe(200)
    expect(run).toHaveBeenCalledTimes(2)
    await gateway.close()
  })

  it('rejects unsigned webhook traffic before parsing or waking an agent', async () => {
    const { gateway } = await harness()
    const run = vi.spyOn(gateway.agents, 'run')
    tunnel.verify = false
    expect((await gateway.handleRequest(email('event-1'))).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
    await gateway.close()
  })

  it('deduplicates before wake-up and replies on the originating email thread', async () => {
    const { gateway, identity } = await harness()
    vi.spyOn(gateway.agents, 'run').mockResolvedValue('A useful response')

    expect((await gateway.handleRequest(email('event-2'))).status).toBe(202)
    expect((await gateway.handleRequest(email('event-2'))).status).toBe(200)
    await vi.waitFor(() => expect(identity.sendEmail).toHaveBeenCalledOnce())
    expect(identity.sendEmail).toHaveBeenCalledWith({
      to: ['person@example.test'],
      subject: 'Re: Question',
      bodyText: 'A useful response',
      inReplyToMessageId: '<event-2@example.test>',
    })
    await vi.waitFor(() => expect(gateway.state.snapshot().replied['event-2']).toBeTypeOf('number'))
    await gateway.close()
  })

  it('steers an active contact turn instead of starting a competing turn', async () => {
    const { gateway, identity } = await harness()
    let finish: ((value: string) => void) | undefined
    vi.spyOn(gateway.agents, 'run').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const steer = vi.spyOn(gateway.agents, 'steer').mockResolvedValue()

    await gateway.handleRequest(email('event-3', 'First'))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await gateway.handleRequest(email('event-4', 'Second'))
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())
    expect(steer).toHaveBeenCalledWith('contact:contact-1', expect.stringContaining('Second'))
    finish?.('Combined response')
    await vi.waitFor(() => expect(identity.sendEmail).toHaveBeenCalledOnce())
    expect(gateway.state.snapshot().replied).toMatchObject({
      'event-3': expect.any(Number),
      'event-4': expect.any(Number),
    })
    await gateway.close()
  })

  it('queues a new turn when an event arrives after model completion during delivery', async () => {
    const { gateway, identity } = await harness()
    let releaseDelivery: (() => void) | undefined
    identity.sendEmail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDelivery = () => resolve({ id: 'mail-delayed' })
        }),
    )
    const run = vi
      .spyOn(gateway.agents, 'run')
      .mockResolvedValueOnce('First response')
      .mockResolvedValueOnce('Second response')

    await gateway.handleRequest(email('event-after-1', 'First'))
    await vi.waitFor(() => expect(releaseDelivery).toBeTypeOf('function'))
    await gateway.handleRequest(email('event-after-2', 'Second'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    releaseDelivery?.()
    await vi.waitFor(() => expect(identity.sendEmail).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(gateway.state.snapshot().replied).toMatchObject({
        'event-after-1': expect.any(Number),
        'event-after-2': expect.any(Number),
      }),
    )
    await gateway.close()
  })

  it('routes approval prompts and email answers through the same contact channel', async () => {
    const { gateway, identity } = await harness(30_000)
    const agent = {} as Agent
    vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue('contact:contact-1')
    await gateway.handleRequest(email('event-5', 'Initial request'))

    const approval = gateway.askApproval(agent, 'Send the requested message')
    await vi.waitFor(() => expect(identity.sendEmail).toHaveBeenCalledOnce())
    expect(identity.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ bodyText: expect.stringContaining('Reply YES') }),
    )
    await gateway.handleRequest(email('event-6', 'YES, approved'))
    await expect(approval).resolves.toBe('allowed-once')
    await gateway.close()
  })

  it('suppresses channel delivery when the agent returns the silent marker', async () => {
    const { gateway, identity } = await harness()
    vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    await gateway.handleRequest(email('event-7'))
    await vi.waitFor(() => expect(gateway.state.snapshot().replied['event-7']).toBeTypeOf('number'))
    expect(identity.sendEmail).not.toHaveBeenCalled()
    await gateway.close()
  })

  it('suppresses explanatory text when the model ends with the silent marker', async () => {
    const { gateway, identity } = await harness()
    vi.spyOn(gateway.agents, 'run').mockResolvedValue('Nothing requires follow-up.\n\n[SILENT]')
    await gateway.handleRequest(email('event-8'))
    await vi.waitFor(() => expect(gateway.state.snapshot().replied['event-8']).toBeTypeOf('number'))
    expect(identity.sendEmail).not.toHaveBeenCalled()
    expect(isSilentResponse('Nothing requires follow-up.\n[SILENT]')).toBe(true)
    await gateway.close()
  })

  it('persists a failed delivery and retries without rerunning the agent', async () => {
    const { gateway, identity } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('Retry this response')
    identity.sendEmail.mockRejectedValueOnce(new Error('temporary delivery failure'))
    await gateway.handleRequest(email('event-9'))
    await vi.waitFor(() => expect(gateway.state.snapshot().deliveries['event-9']).toBeDefined())
    expect(gateway.state.snapshot().replied['event-9']).toBeUndefined()
    await vi.waitFor(() => expect(identity.sendEmail).toHaveBeenCalledTimes(2), { timeout: 2_000 })
    await vi.waitFor(() => expect(gateway.state.snapshot().replied['event-9']).toBeTypeOf('number'))
    expect(gateway.state.snapshot().deliveries['event-9']).toBeUndefined()
    expect(run).toHaveBeenCalledOnce()
    await gateway.close()
  })
})
