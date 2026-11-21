import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { type AgentIdentity, type Inkbox, InkboxAPIError } from '@inkbox/sdk'
import type { TunnelListener } from '@inkbox/sdk/tunnels/connect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import {
  Gateway,
  IMESSAGE_TYPING_MAX_MS,
  IMESSAGE_TYPING_REFRESH_MS,
  isSilentResponse,
} from '../src/gateway.js'
import {
  INBOUND_BODY_MAX_BYTES,
  INBOUND_MAX_PENDING_EVENTS,
  INBOUND_RELOAD_DELAY_MS,
  INBOUND_TURN_TIMEOUT_MS,
  InboundStore,
  parseInbound,
} from '../src/inbound.js'
import type { InkboxRuntime } from '../src/runtime.js'
import { VoiceNoteNotAdmitted } from '../src/voice-notes.js'

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

vi.mock('@inkbox/sdk', async (original) => ({
  ...(await original<typeof import('@inkbox/sdk')>()),
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
    sendIMessageTyping: ReturnType<typeof vi.fn>
  }
  subscriptions: {
    list: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  stateDir: string
  client: { inbound?: { reportInboundEventResult: ReturnType<typeof vi.fn> } }
}

async function harness(
  batchWindowMs = 0,
  voiceStack: ResolvedConfig['voiceStack'] = 'inkbox_voice_ai',
  channelInstructions: Record<string, string> = {},
  sharedEvents: string[] = [],
  unsupportedTranscription = false,
  existingStateDir?: string,
): Promise<Harness> {
  const stateDir = existingStateDir ?? (await mkdtemp(join(tmpdir(), 'inkbox-gateway-')))
  // Inbound scripts run in the home directory.
  vi.stubEnv('HOME', stateDir)
  const subscriptions = {
    list: vi.fn(async (filter: { scope?: string; url: string }) =>
      filter.scope === 'identity' && sharedEvents.length
        ? [{ id: 'shared', url: filter.url, eventTypes: sharedEvents }]
        : [],
    ),
    create: vi.fn(async (row: { eventTypes: string[] }) => {
      if (unsupportedTranscription && row.eventTypes.includes('message.transcription_finished'))
        throw Object.assign(new InkboxAPIError(422, 'Unknown event'), {
          detail: [
            {
              type: 'enum',
              loc: ['body', 'event_types', 0, 'MailWebhookEventType'],
              input: 'message.transcription_finished',
            },
          ],
        })
      return { signingKey: null }
    }),
    update: vi.fn(async () => ({})),
  }
  const client: Record<string, unknown> = {
    webhooks: { subscriptions },
    inbound: { reportInboundEventResult: vi.fn(async () => {}) },
  }
  const identity = {
    id: 'identity-1',
    agentHandle: 'deepseek-agent',
    mailbox: { id: 'mailbox-1' },
    phoneNumber: { id: 'phone-1' },
    sendEmail: vi.fn(async () => ({ id: 'mail-1' })),
    sendText: vi.fn(async () => ({ id: 'text-1' })),
    sendIMessage: vi.fn(async () => ({ id: 'imessage-1' })),
    sendIMessageTyping: vi.fn(async () => {}),
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
    autoApproveInkboxTools: false,
    externalEvents: false,
    slackEnabled: false,
    voiceEnabled: true,
    voiceStack,
    realtimeCredentialRef: 'INKBOX_REALTIME_API_KEY',
    realtimeModel: 'gpt-realtime-2',
    realtimeVoice: 'cedar',
    channelInstructions,
  }
  const gateway = new Gateway(ctx, runtime, config, {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })
  await gateway.start()
  return { gateway, identity, subscriptions, stateDir, client: client as Harness['client'] }
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

function sms(id: string, body = 'Hello from SMS'): Request {
  return new Request('https://agent.example.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': 'signed' },
    body: JSON.stringify({
      id,
      event_type: 'text.received',
      data: {
        text_message: {
          sender_phone_number: '+15550000001',
          conversation_id: 'sms-conversation-1',
          text: body,
        },
        contacts: [{ id: 'contact-1', address: '+15550000001' }],
      },
    }),
  })
}

function imessage(id: string, body = 'Hello from iMessage', group = false): Request {
  return new Request('https://agent.example.test/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': 'signed' },
    body: JSON.stringify({
      id,
      event_type: 'imessage.received',
      data: {
        message: {
          sender_number: '+15550000001',
          conversation_id: group ? 'imessage-group-1' : 'imessage-conversation-1',
          content: body,
          is_group: group,
        },
        contacts: [{ id: 'contact-1', address: '+15550000001' }],
      },
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
  vi.unstubAllEnvs()
})

describe('gateway lifecycle and delivery', () => {
  it('rebuilds removed local tunnel state and retries exactly once', async () => {
    tunnel.connect.mockImplementationOnce(async (_client, options) => {
      await mkdir(options.stateDir, { recursive: true })
      await writeFile(join(options.stateDir, 'state.json'), '{"tunnel_id":"removed"}\n')
      const error = new Error('cached tunnel was removed')
      error.name = 'TunnelRemoved'
      throw error
    })

    const { gateway, stateDir } = await harness()
    expect(tunnel.connect).toHaveBeenCalledTimes(2)
    await expect(readFile(join(stateDir, 'tunnel', 'state.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await gateway.close()
  })

  it('connects the tunnel and reconciles every configured channel', async () => {
    const { gateway, subscriptions, stateDir } = await harness()
    expect(gateway.status()).toMatchObject({ ready: true, connected: true, identity: 'deepseek-agent' })
    expect(subscriptions.create).toHaveBeenCalledTimes(7)
    // WhatsApp and transcription are excluded from the legacy unscoped list.
    const identityLookups = subscriptions.list.mock.calls.filter(([query]) => query.scope === 'identity')
    expect(identityLookups).toHaveLength(2)
    await gateway.close()
    expect(tunnel.aclose).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(stateDir, 'status.json'), 'utf8'))).toMatchObject({
      ready: false,
    })
  })

  it('starts on an API without transcription callbacks and still registers WhatsApp', async () => {
    const { gateway, subscriptions } = await harness(0, 'inkbox_voice_ai', {}, [], true)
    try {
      expect(gateway.status().ready).toBe(true)
      expect(subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventTypes: ['whatsapp.received'] }),
      )
    } finally {
      await gateway.close()
    }
  })

  it('keeps an existing shared WhatsApp receiver intact across two starts', async () => {
    const shared = ['whatsapp.received', 'whatsapp.future']
    for (let start = 0; start < 2; start++) {
      const { gateway, subscriptions } = await harness(0, 'inkbox_voice_ai', {}, shared)
      expect(
        subscriptions.create.mock.calls.some(([row]) => row.eventTypes.includes('whatsapp.received')),
      ).toBe(false)
      expect(subscriptions.update).not.toHaveBeenCalled()
      await gateway.close()
    }
  })

  it('attaches authenticated Realtime calls to the same contact-scoped Harness agent', async () => {
    const { gateway } = await harness(0, 'openai_realtime', {
      'contact-live-1': 'Use the caller-specific call style.',
    })
    const run = vi
      .spyOn(gateway.agents, 'run')
      .mockResolvedValueOnce('Calendar checked')
      .mockResolvedValueOnce('[SILENT]')
    await tunnel.wsHandler?.({
      url: 'wss://agent.example.test/phone/media/ws',
      headers: new Map(),
    })
    expect(liveCall.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-realtime',
        model: 'gpt-realtime-2',
        voice: 'cedar',
        additionalInstructions: expect.stringContaining('Use the caller-specific call style.'),
      }),
      expect.objectContaining({ callId: 'call-live-1' }),
    )
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0]?.[0]).toBe('contact:contact-live-1')
    expect(run.mock.calls[0]?.[1]).toContain('[trusted Inkbox channel policy]\nChannel: call')
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

  it('shows typing for a one-to-one iMessage and sends a plain-text reply', async () => {
    const { gateway, identity } = await harness()
    vi.spyOn(gateway.agents, 'run').mockResolvedValue(
      '# Update\n\n**Done**\n- First item\n[Report](https://example.test/report)',
    )

    expect((await gateway.handleRequest(imessage('event-imessage-1'))).status).toBe(202)
    await vi.waitFor(() => expect(identity.sendIMessageTyping).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(identity.sendIMessage).toHaveBeenCalledOnce())
    expect(identity.sendIMessage).toHaveBeenCalledWith({
      conversationId: 'imessage-conversation-1',
      text: 'Update\n\nDone\nFirst item\nReport: https://example.test/report',
    })
    await gateway.close()
  })

  it('refreshes one typing pulse and cancels it after a silent turn', async () => {
    const { gateway, identity } = await harness()
    vi.useFakeTimers()
    let finish: ((value: string) => void) | undefined
    vi.spyOn(gateway.agents, 'run').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    try {
      await gateway.handleRequest(imessage('event-imessage-pulse'))
      await vi.advanceTimersByTimeAsync(0)
      expect(identity.sendIMessageTyping).toHaveBeenCalledOnce()
      expect(IMESSAGE_TYPING_REFRESH_MS).toBe(40_000)
      expect(IMESSAGE_TYPING_MAX_MS).toBe(600_000)

      await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS)
      expect(identity.sendIMessageTyping).toHaveBeenCalledTimes(2)
      finish?.('[SILENT]')
      await vi.advanceTimersByTimeAsync(0)
      const stoppedAt = identity.sendIMessageTyping.mock.calls.length
      await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS * 2)
      expect(identity.sendIMessageTyping).toHaveBeenCalledTimes(stoppedAt)
      expect(identity.sendIMessage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      await gateway.close()
    }
  })

  it('expires a typing pulse at the ten-minute safety cap while a turn is still running', async () => {
    const { gateway, identity } = await harness()
    vi.useFakeTimers()
    let finish: ((value: string) => void) | undefined
    vi.spyOn(gateway.agents, 'run').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    try {
      await gateway.handleRequest(imessage('event-imessage-cap'))
      await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_MAX_MS)
      const pulsesAtCap = identity.sendIMessageTyping.mock.calls.length
      expect(pulsesAtCap).toBeGreaterThan(1)
      await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS * 2)
      expect(identity.sendIMessageTyping).toHaveBeenCalledTimes(pulsesAtCap)
      finish?.('[SILENT]')
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
      await gateway.close()
    }
  })

  it('cancels a queued typing pulse during gateway shutdown', async () => {
    const { gateway, identity } = await harness(30_000)
    vi.useFakeTimers()
    try {
      await gateway.handleRequest(imessage('event-imessage-shutdown'))
      await vi.advanceTimersByTimeAsync(0)
      expect(identity.sendIMessageTyping).toHaveBeenCalledOnce()
      await gateway.close()
      await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS * 2)
      expect(identity.sendIMessageTyping).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never shows typing for a group iMessage', async () => {
    const { gateway, identity } = await harness()
    vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    await gateway.handleRequest(imessage('event-imessage-group', 'Hello group', true))
    await vi.waitFor(() =>
      expect(gateway.state.snapshot().replied['event-imessage-group']).toBeTypeOf('number'),
    )
    expect(identity.sendIMessageTyping).not.toHaveBeenCalled()
    await gateway.close()
  })

  it('switches trusted channel policy per event in one persistent contact session', async () => {
    const { gateway } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')

    await gateway.handleRequest(email('event-channel-email'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await gateway.handleRequest(sms('event-channel-sms'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))

    expect(run.mock.calls[0]?.[0]).toBe('contact:contact-1')
    expect(run.mock.calls[1]?.[0]).toBe('contact:contact-1')
    expect(run.mock.calls[0]?.[1]).toContain('Channel: email')
    expect(run.mock.calls[0]?.[1]).toContain('professional, complete email reply')
    expect(run.mock.calls[0]?.[1]).not.toContain('Channel: sms')
    expect(run.mock.calls[1]?.[1]).toContain('Channel: sms')
    expect(run.mock.calls[1]?.[1]).toContain('concise and plain text')
    expect(run.mock.calls[1]?.[1]).not.toContain('Channel: email')
    await gateway.close()
  })

  it('applies contact instructions to every channel without binding the session to one channel', async () => {
    const { gateway } = await harness(0, 'inkbox_voice_ai', {
      email: 'Standard email policy.',
      sms: 'Standard SMS policy.',
      'contact-1': 'Always include the account reference.',
    })
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    await gateway.handleRequest(email('event-contact-email'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await gateway.handleRequest(sms('event-contact-sms'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    for (const call of run.mock.calls) {
      expect(call[1]).toContain('Always include the account reference.')
      expect(call[1]).not.toContain('Standard email policy.')
      expect(call[1]).not.toContain('Standard SMS policy.')
    }
    await gateway.close()
  })

  it('labels every event independently when different channels share one batch', async () => {
    const { gateway } = await harness(20)
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    await gateway.handleRequest(email('event-batch-email'))
    await gateway.handleRequest(sms('event-batch-sms'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run.mock.calls[0]?.[1].match(/\[trusted Inkbox channel policy\]/g)).toHaveLength(2)
    expect(run.mock.calls[0]?.[1]).toContain('Channel: email')
    expect(run.mock.calls[0]?.[1]).toContain('Channel: sms')
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
    expect(steer).toHaveBeenCalledWith(
      'contact:contact-1',
      expect.stringContaining('[trusted Inkbox channel policy]\nChannel: email'),
    )
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
    expect(run).toHaveBeenCalledTimes(1)
    expect(gateway.eventState('event-after-1')).toBe('pending')
    expect(gateway.eventState('event-after-2')).toBe('pending')
    releaseDelivery?.()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
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
    identity.sendEmail.mockRejectedValueOnce(new InkboxAPIError(429, 'Synthetic rate limit'))
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

it('retains uncertain delivery and per-event ownership after a lost response', async () => {
  const { gateway, identity } = await harness()
  vi.spyOn(gateway.agents, 'run').mockResolvedValue('Synthetic final reply')
  identity.sendEmail.mockRejectedValueOnce(new Error('Synthetic lost response'))
  await gateway.handleRequest(email('uncertain-event'))
  expect(gateway.eventState('uncertain-event')).toBe('pending')
  await vi.waitFor(() => expect(gateway.eventState('uncertain-event')).toBe('uncertain'))
  expect(gateway.state.snapshot().replied['uncertain-event']).toBeUndefined()
  gateway.resumeDeliveries()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(identity.sendEmail).toHaveBeenCalledOnce()
  expect(gateway.activity().deliveries).toBe(0)
  expect(gateway.activity().uncertain).toBe(1)
  await gateway.close()
})

it('distinguishes accepted, completed and lost native event ownership', async () => {
  const { gateway } = await harness(50)
  vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
  expect(gateway.eventState('event-state')).toBe('absent')
  await gateway.handleRequest(email('event-state'))
  expect(gateway.eventState('event-state')).toBe('pending')
  await vi.waitFor(() => expect(gateway.eventState('event-state')).toBe('completed'))
  await gateway.state.mutate((state) => {
    state.seen.lost = Date.now()
  })
  expect(gateway.eventState('lost')).toBe('uncertain')
  await gateway.close()
})

it('does not count rejected replies as running work', async () => {
  const { gateway } = await harness()
  await gateway.state.mutate((state) => {
    state.deliveries.rejected = {
      state: 'rejected',
      eventIds: ['rejected'],
      target: { channel: 'none' },
      response: '',
      attempts: 1,
      nextAttemptAt: 0,
    }
  })
  expect(gateway.eventState('rejected')).toBe('failed')
  expect(gateway.activity()).toMatchObject({ deliveries: 0, uncertain: 0 })
  await gateway.close()
})

it('quarantines lost replies without retrying them', async () => {
  const { gateway, identity } = await harness()
  vi.spyOn(gateway.agents, 'run').mockResolvedValue('Synthetic final reply')
  identity.sendEmail.mockRejectedValueOnce(new Error('Synthetic lost response'))
  await gateway.handleRequest(email('quarantine-event'))
  await vi.waitFor(() => expect(gateway.eventState('quarantine-event')).toBe('uncertain'))
  await gateway.quarantineDelivery('quarantine-event')
  expect(gateway.eventState('quarantine-event')).toBe('failed')
  expect(gateway.activity()).toMatchObject({ deliveries: 0, uncertain: 0 })
  gateway.resumeDeliveries()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(identity.sendEmail).toHaveBeenCalledOnce()
  await gateway.close()
})

describe('authenticated voice-note dispatch', () => {
  it('routes one labeled turn from the original after completion and registers every completion family', async () => {
    const { gateway, subscriptions } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    const message = {
      id: 'voice-message',
      conversation_id: 'imessage-voice',
      sender_number: '+15555550123',
      content: 'Original caption',
      direction: 'inbound',
      media: [{ id: 'audio-1', transcription: { status: 'pending' } }],
    }
    const original = { id: 'received-voice', event_type: 'imessage.received', data: { message } }
    try {
      const completionRows = subscriptions.create.mock.calls.filter(([row]) =>
        row.eventTypes.includes('message.transcription_finished'),
      )
      expect(completionRows).toEqual([
        [
          expect.objectContaining({
            agentIdentityId: 'identity-1',
            eventTypes: ['message.transcription_finished'],
          }),
        ],
      ])
      expect((await gateway.dispatchVerified(original, 'inkbox')).status).toBe(202)
      expect(run).not.toHaveBeenCalled()
      const finished = {
        id: 'finished-voice',
        event_type: 'message.transcription_finished',
        data: {
          channel: 'imessage',
          message_id: message.id,
          message: {
            ...message,
            media: [
              {
                id: 'audio-1',
                transcription: { status: 'completed', text: 'Move the meeting to Thursday.' },
              },
            ],
          },
        },
      }
      await gateway.dispatchVerified(finished, 'inkbox')
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
      const turn = { signal: expect.any(AbortSignal) }
      expect(run).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Move the meeting to Thursday.'),
        turn,
      )
      expect(run).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Voice note'), turn)
      await gateway.dispatchVerified(finished, 'inkbox')
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      await gateway.close()
    }
  })
})

it('keeps an attachment-only voice note instead of consuming an empty approval answer', async () => {
  const { gateway, identity } = await harness(30_000)
  vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue('contact:contact-1')
  await gateway.handleRequest(email('permission-request', 'Initial request'))
  const approval = gateway.askApproval({} as Agent, 'Send the requested message')
  let settled = false
  void approval.then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(identity.sendEmail).toHaveBeenCalledOnce())
  await gateway.dispatchVerified(
    {
      id: 'voice-during-approval',
      event_type: 'text.received',
      data: {
        text_message: {
          id: 'voice-source',
          conversation_id: 'sms-voice',
          sender_phone_number: '+15550001111',
          text: '',
          media: [{ id: 'voice-audio', transcription: { status: 'completed', text: 'YES approved' } }],
        },
        contacts: [{ id: 'contact-1' }],
      },
    },
    'inkbox',
  )
  expect(settled).toBe(false)
  expect(gateway.eventState('voice-during-approval')).toBe('pending')
  await gateway.handleRequest(email('typed-approval', 'YES, approved'))
  await expect(approval).resolves.toBe('allowed-once')
  await gateway.close()
})

it('refuses a resolved voice note before reserving its event when the gateway has stopped', async () => {
  const { gateway } = await harness()
  await gateway.close()
  const event = { event_type: 'text.received', id: 'voice-while-stopped' }
  await expect(gateway.dispatchVerified(event, 'inkbox', true)).rejects.toBeInstanceOf(VoiceNoteNotAdmitted)
  expect(gateway.state.snapshot().seen[event.id]).toBeUndefined()
})

it.each(['ignored', 'not-reserved', 'reserved'] as const)(
  'classifies voice-note handoff at the reservation boundary (%s)',
  async (outcome) => {
    const { gateway, stateDir } = await harness()
    try {
      const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
      const message = {
        id: 'note',
        conversation_id: 'thread',
        ...(outcome === 'ignored' ? {} : { sender_number: '+15555550123' }),
        media: [{ id: 'audio', transcription: { status: 'pending' } }],
      }
      await gateway.dispatchVerified(
        { id: 'original', event_type: 'imessage.received', data: { message } },
        'inkbox',
      )
      if (outcome === 'not-reserved') {
        vi.spyOn(gateway.state, 'mutate').mockRejectedValueOnce(new Error('Store unavailable'))
      } else if (outcome === 'reserved') {
        const mutate = gateway.state.mutate.bind(gateway.state)
        vi.spyOn(gateway.state, 'mutate').mockImplementationOnce(async (change) => {
          await mutate(change)
          throw new Error('Lock release failed after commit')
        })
      }
      await gateway.dispatchVerified(
        {
          id: 'completion',
          event_type: 'message.transcription_finished',
          data: {
            channel: 'imessage',
            message_id: 'note',
            message: {
              ...message,
              media: [{ id: 'audio', transcription: { status: 'completed', text: 'Hello' } }],
            },
          },
        },
        'inkbox',
      )
      await vi.waitFor(async () => {
        const receipt = JSON.parse(await readFile(join(stateDir, 'voice-notes-identity-1.json'), 'utf8'))
        if (outcome === 'ignored') {
          expect(receipt.done['imessage:note']).toBeDefined()
          expect(receipt.pending['imessage:note']).toBeUndefined()
        } else {
          expect(receipt.pending['imessage:note'].handoff).toBe(
            outcome === 'reserved' ? 'attempting' : 'retry',
          )
          expect(gateway.state.snapshot().seen.original !== undefined).toBe(outcome === 'reserved')
        }
      })
      expect(run).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  },
)

const ACTIVATION_ID = '0b9f3c1e-5d0a-4c55-9d43-6f1f8f5f2a10'

function envelopeId(deliveryId: string): string {
  return `evt_${createHash('sha256').update(`inbound:${deliveryId}`).digest('hex')}`
}

// The signed envelope a hosted agent receives: the event payload plus `id` and `hosted_delivery`.
function inbound(
  eventId: string,
  handler: Record<string, unknown> = { type: 'agent' },
  request: Record<string, unknown> = { body: '{"type":"charge.succeeded"}', body_encoding: 'utf8' },
  deliveryId: string | null = `1d6b3c3e-0000-4000-8000-${eventId.slice(-12).padStart(12, '0')}`,
): Request {
  const id = envelopeId(deliveryId ?? eventId)
  return new Request('http://127.0.0.1/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': 'signed' },
    body: JSON.stringify({
      data: {
        ...(deliveryId === null ? {} : { delivery_id: deliveryId }),
        event_id: eventId,
        handler,
        received_at: '2026-11-19T00:00:00+00:00',
        request: {
          body_encoding: 'utf8',
          content_type: 'application/json',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          query: {},
          ...request,
        },
        signature_verified: true,
        source: {
          id: 'inbsrc_5a2f7c9e-1b3d-4e6f-8a9b-0c1d2e3f4a5b',
          instructions: 'Record every successful charge.',
          name: 'payments',
        },
      },
      event_type: 'inbound.received',
      hosted_delivery: { activation_id: ACTIVATION_ID, event_id: id, starts_agent: true, version: 1 },
      id,
      timestamp: '2026-11-19T00:00:00+00:00',
    }),
  })
}

function trackingId(request: Request): Promise<string> {
  return request
    .clone()
    .json()
    .then((body: { id: string }) => body.id)
}

const SOURCE_ID = 'inbsrc_5a2f7c9e-1b3d-4e6f-8a9b-0c1d2e3f4a5b'

it('ignores inbound events outside local delivery', async () => {
  const { gateway } = await harness()
  const run = vi.spyOn(gateway.agents, 'run')
  try {
    const request = inbound('inbev_ignored')
    const id = await trackingId(request)
    expect((await gateway.handleRequest(request)).status).toBe(202)
    expect(gateway.eventState(id)).toBe('absent')
    expect(run).not.toHaveBeenCalled()
  } finally {
    await gateway.close()
  }
})

// vi.waitFor advances fake timers while polling, which would shift the retry schedule.
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error('Condition not met')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function scheduled(gateway: Gateway): number {
  return (gateway as unknown as { inboundTimers: Map<string, unknown> }).inboundTimers.size
}

async function queued(stateDir: string): Promise<number> {
  return (await readdir(join(stateDir, 'inbound')).catch(() => [])).filter((name) => name.endsWith('.json'))
    .length
}

describe('local delivery', () => {
  beforeEach(() => {
    process.env.INKBOX_DELIVERY_MODE = 'local'
  })
  afterEach(() => {
    delete process.env.INKBOX_DELIVERY_MODE
    vi.useRealTimers()
  })

  it('opens no tunnel, registers no URL and accepts bodies up to 2 MiB', async () => {
    const { gateway, subscriptions } = await harness()
    vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    try {
      expect(tunnel.connect).not.toHaveBeenCalled()
      expect(subscriptions.list).not.toHaveBeenCalled()
      expect(subscriptions.create).not.toHaveBeenCalled()
      expect(gateway.status()).toMatchObject({ ready: true, connected: false })
      expect(gateway.status().publicUrl).toBeUndefined()
      const body = 'x'.repeat(2 * 1024 * 1024 - 2_000)
      expect((await gateway.handleRequest(inbound('inbev_large', { type: 'agent' }, { body }))).status).toBe(
        202,
      )
      const tooLarge = new Request('http://127.0.0.1/webhook', {
        method: 'POST',
        body: 'x'.repeat(2 * 1024 * 1024 + 1),
      })
      expect((await gateway.handleRequest(tooLarge)).status).toBe(413)
      tunnel.verify = false
      expect((await gateway.handleRequest(inbound('inbev_unsigned'))).status).toBe(401)
    } finally {
      tunnel.verify = true
      await gateway.close()
    }
  })

  it('completes the delivery once persisted and runs one untrusted agent turn per delivery id', async () => {
    const { gateway, identity, stateDir } = await harness()
    let finish: (value: string) => void = () => {}
    const run = vi
      .spyOn(gateway.agents, 'run')
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    try {
      const request = inbound('inbev_1')
      const id = await trackingId(request)
      expect((await gateway.handleRequest(request)).status).toBe(202)
      expect(gateway.eventState(id)).toBe('completed')
      expect(await queued(stateDir)).toBe(1)
      expect((await gateway.handleRequest(inbound('inbev_1'))).status).toBe(200)
      await until(() => run.mock.calls.length === 1)
      expect(gateway.activity().active).toBeGreaterThan(0)
      finish('Recorded')
      await until(async () => (await queued(stateDir)) === 0)
      await until(() => gateway.activity().active === 0)
      expect((await gateway.handleRequest(inbound('inbev_1'))).status).toBe(200)
      expect(run).toHaveBeenCalledOnce()
      const [route, prompt = ''] = run.mock.calls[0] ?? []
      expect(route).toBe(`inbound:${SOURCE_ID}`)
      expect(prompt).toContain('Untrusted external content received from inbound source "payments"')
      expect(prompt.indexOf('Record every successful charge.')).toBeLessThan(
        prompt.indexOf('{"type":"charge.succeeded"}'),
      )
      expect(prompt).toMatch(/\[untrusted incoming content\]\n\{"type":"charge.succeeded"\}/)
      expect(identity.sendEmail).not.toHaveBeenCalled()
      expect(identity.sendText).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })

  it('runs a replay again under a new delivery id', async () => {
    const { gateway } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    try {
      expect((await gateway.handleRequest(inbound('inbev_r'))).status).toBe(202)
      await until(() => run.mock.calls.length === 1)
      const replay = inbound('inbev_r', undefined, undefined, '1d6b3c3e-0000-4000-8000-00000000beef')
      expect((await gateway.handleRequest(replay)).status).toBe(202)
      await until(() => run.mock.calls.length === 2)
    } finally {
      await gateway.close()
    }
  })

  it('rejects an inbound event without a delivery id with 400 before host admission', async () => {
    const { gateway, stateDir } = await harness()
    const run = vi.spyOn(gateway.agents, 'run')
    const admitted = vi.spyOn(gateway, 'dispatchVerified')
    try {
      expect((await gateway.handleRequest(inbound('inbev_n', undefined, undefined, null))).status).toBe(400)
      expect(admitted).not.toHaveBeenCalled()
      expect(await queued(stateDir)).toBe(0)
      expect(run).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })

  it('caps the agent body at 64 KiB', async () => {
    const { gateway } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    try {
      const body = 'x'.repeat(INBOUND_BODY_MAX_BYTES + 100)
      await gateway.handleRequest(inbound('inbev_big', { type: 'agent' }, { body, body_encoding: 'utf8' }))
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      const prompt = run.mock.calls[0]?.[1] ?? ''
      expect(prompt).toContain(`${'x'.repeat(INBOUND_BODY_MAX_BYTES)}\n(truncated)`)
      expect(prompt).not.toContain('x'.repeat(INBOUND_BODY_MAX_BYTES + 1))
    } finally {
      await gateway.close()
    }
  })

  it('caps script output in the agent message but passes the full body on stdin', async () => {
    const { gateway, stateDir } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    try {
      const body = 'y'.repeat(INBOUND_BODY_MAX_BYTES + 100)
      const command = `tee input.json | head -c ${INBOUND_BODY_MAX_BYTES + 100}`
      await gateway.handleRequest(
        inbound('inbev_bigout', { type: 'script', command }, { body, body_encoding: 'utf8' }),
      )
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(JSON.parse(await readFile(join(stateDir, 'input.json'), 'utf8')).body).toBe(body)
      expect(run.mock.calls[0]?.[1]).toContain('\n(truncated)')
      expect(run.mock.calls[0]?.[1]).not.toContain('y'.repeat(INBOUND_BODY_MAX_BYTES + 1))
    } finally {
      await gateway.close()
    }
  })

  it('describes a binary body instead of passing it to the agent', async () => {
    const { gateway } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    try {
      await gateway.handleRequest(
        inbound('inbev_bin', { type: 'agent' }, { body: '//4A', body_encoding: 'base64' }),
      )
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(run.mock.calls[0]?.[1]).toContain('(binary body, 3 bytes, not shown)')
    } finally {
      await gateway.close()
    }
  })

  it('shows a base64 body that decodes to UTF-8 as text', async () => {
    const { gateway } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    try {
      const body = Buffer.from('{"note":"café"}').toString('base64')
      await gateway.handleRequest(inbound('inbev_b64', { type: 'agent' }, { body, body_encoding: 'base64' }))
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      expect(run.mock.calls[0]?.[1]).toContain('{"note":"café"}')
      expect(run.mock.calls[0]?.[1]).not.toContain('binary body')
    } finally {
      await gateway.close()
    }
  })

  it('acknowledges a duplicate only after the first copy is stored', async () => {
    const { gateway } = await harness()
    vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    const save = InboundStore.prototype.save
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(InboundStore.prototype, 'save').mockImplementationOnce(async function (
      this: InboundStore,
      item,
    ) {
      await gate
      return save.call(this, item)
    })
    try {
      let duplicateDone = false
      const first = gateway.handleRequest(inbound('inbev_dup'))
      await until(() => spy.mock.calls.length === 1)
      const duplicate = gateway.handleRequest(inbound('inbev_dup')).then((response) => {
        duplicateDone = true
        return response
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(duplicateDone).toBe(false)
      release()
      expect((await first).status).toBe(202)
      expect((await duplicate).status).toBe(200)
    } finally {
      spy.mockRestore()
      await gateway.close()
    }
  })

  it('caps the reported error at 2000 characters', async () => {
    const { gateway, stateDir, client } = await harness()
    vi.spyOn(gateway.agents, 'run').mockRejectedValue(new Error(`${'e'.repeat(5_000)}END`))
    try {
      await gateway.handleRequest(inbound('inbev_longerr'))
      await until(async () => (await queued(stateDir)) === 0)
      const [, , , result] = client.inbound?.reportInboundEventResult.mock.calls[0] ?? []
      expect(result.error).toHaveLength(2000)
      expect(result.error.endsWith('END')).toBe(true)
    } finally {
      await gateway.close()
    }
  })

  it('never starts a sixth script run after a restart during the fifth', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-gateway-'))
    const request = inbound('inbev_capped', { type: 'script', command: 'echo run >> attempts' })
    const event = parseInbound(await request.clone().json())
    if (!event) throw new Error('unparsed')
    // Five runs already started; the last one was cut off by the restart.
    await new InboundStore(join(stateDir, 'inbound')).save({
      trackingId: await trackingId(request),
      event,
      attempts: 5,
      dueAt: 0,
    })
    const { gateway, client } = await harness(0, 'inkbox_voice_ai', {}, [], false, stateDir)
    try {
      await until(async () => (await queued(stateDir)) === 0)
      expect(await readFile(join(stateDir, 'attempts'), 'utf8').catch(() => '')).toBe('')
      expect(client.inbound?.reportInboundEventResult).toHaveBeenCalledWith(
        'deepseek-agent',
        SOURCE_ID,
        'inbev_capped',
        expect.objectContaining({ status: 'failed', error: 'Script run was interrupted by a restart' }),
      )
    } finally {
      await gateway.close()
    }
  })

  it('keeps retrying a failure report past 24 hours until it succeeds', async () => {
    const { gateway, stateDir, client } = await harness()
    vi.spyOn(gateway.agents, 'run').mockRejectedValue(new Error('model unavailable'))
    client.inbound?.reportInboundEventResult.mockRejectedValue(new InkboxAPIError(503, 'unavailable'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      await gateway.handleRequest(inbound('inbev_slowreport'))
      const calls = () => client.inbound?.reportInboundEventResult.mock.calls.length ?? 0
      // Each attempt persists before rescheduling, so let real I/O settle between timer steps.
      for (let hour = 0; hour < 30; hour++) {
        await until(() => scheduled(gateway) === 1)
        await vi.advanceTimersByTimeAsync(3_600_000)
      }
      await until(() => scheduled(gateway) === 1)
      expect(await queued(stateDir)).toBe(1)
      expect(calls()).toBeGreaterThan(20)
      client.inbound?.reportInboundEventResult.mockResolvedValue(undefined)
      await vi.advanceTimersByTimeAsync(3_600_000)
      await until(async () => (await queued(stateDir)) === 0)
    } finally {
      vi.useRealTimers()
      await gateway.close()
    }
  })

  it('finishes a script with empty output without an agent turn', async () => {
    const { gateway, stateDir } = await harness()
    const run = vi.spyOn(gateway.agents, 'run')
    try {
      const command = 'cat > input.json'
      expect((await gateway.handleRequest(inbound('inbev_quiet', { type: 'script', command }))).status).toBe(
        202,
      )
      await until(async () => (await queued(stateDir)) === 0)
      expect(JSON.parse(await readFile(join(stateDir, 'input.json'), 'utf8'))).toEqual({
        source: 'payments',
        event_id: 'inbev_quiet',
        headers: { 'content-type': 'application/json' },
        body: '{"type":"charge.succeeded"}',
        body_encoding: 'utf8',
      })
      expect(run).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })

  it('passes script output to the agent as the event body', async () => {
    const { gateway, stateDir } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('[SILENT]')
    try {
      await gateway.handleRequest(
        inbound('inbev_out', { type: 'script', command: 'echo "charge from $(pwd)"' }),
      )
      await until(() => run.mock.calls.length === 1)
      expect(run.mock.calls[0]?.[0]).toBe(`inbound:${SOURCE_ID}`)
      expect(run.mock.calls[0]?.[1]).toContain(
        `[untrusted incoming content]\ncharge from ${await realpath(stateDir)}`,
      )
      expect(run.mock.calls[0]?.[1]).toContain('Record every successful charge.')
      expect(run.mock.calls[0]?.[2]).toMatchObject({ failOnError: true })
    } finally {
      await gateway.close()
    }
  })

  it('runs a failing script 5 times on the backoff schedule, then reports failure', async () => {
    const { gateway, stateDir, client } = await harness()
    const report = client.inbound?.reportInboundEventResult
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const command = 'echo run >> attempts; echo boom >&2; exit 3'
      const request = inbound('inbev_fail', { type: 'script', command })
      const id = await trackingId(request)
      const deliveryId = JSON.parse(await request.clone().text()).data.delivery_id
      expect((await gateway.handleRequest(request)).status).toBe(202)
      expect(gateway.eventState(id)).toBe('completed')
      await vi.advanceTimersByTimeAsync(0)
      const attempts = async () =>
        (await readFile(join(stateDir, 'attempts'), 'utf8').catch(() => '')).split('\n').length - 1
      for (const [index, delay] of [10_000, 30_000, 120_000, 600_000].entries()) {
        await until(async () => (await attempts()) === index + 1)
        await until(() => scheduled(gateway) === 1)
        expect(gateway.activity().active).toBe(1)
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(await attempts()).toBe(index + 1)
        await vi.advanceTimersByTimeAsync(1)
      }
      await until(async () => (await attempts()) === 5)
      await until(() => scheduled(gateway) === 1)
      await vi.advanceTimersByTimeAsync(0)
      await until(async () => (await queued(stateDir)) === 0)
      expect(await attempts()).toBe(5)
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(await attempts()).toBe(5)
      expect(gateway.activity().active).toBe(0)
      expect(report).toHaveBeenCalledWith('deepseek-agent', SOURCE_ID, 'inbev_fail', {
        status: 'failed',
        error: 'boom',
        deliveryId,
      })
    } finally {
      vi.useRealTimers()
      await gateway.close()
    }
  })

  it('reports a failed agent turn once without running it again', async () => {
    const { gateway, stateDir, client } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockRejectedValue(new Error('model unavailable'))
    try {
      await gateway.handleRequest(inbound('inbev_agentfail'))
      await until(async () => (await queued(stateDir)) === 0)
      expect(scheduled(gateway)).toBe(0)
      expect(run).toHaveBeenCalledOnce()
      expect(client.inbound?.reportInboundEventResult).toHaveBeenCalledOnce()
      expect(client.inbound?.reportInboundEventResult).toHaveBeenCalledWith(
        'deepseek-agent',
        SOURCE_ID,
        'inbev_agentfail',
        expect.objectContaining({ status: 'failed', error: 'model unavailable' }),
      )
    } finally {
      await gateway.close()
    }
  })

  it('aborts and reports an agent turn that does not finish within 30 minutes', async () => {
    const { gateway, stateDir, client } = await harness()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let signal: AbortSignal | undefined
    const run = vi.spyOn(gateway.agents, 'run').mockImplementation(
      (_route, _prompt, options) =>
        new Promise((_, reject) => {
          signal = options?.signal
          signal?.addEventListener('abort', () => reject(signal?.reason))
        }),
    )
    try {
      await gateway.handleRequest(inbound('inbev_stuck'))
      await vi.advanceTimersByTimeAsync(0)
      await until(() => run.mock.calls.length === 1)
      await vi.advanceTimersByTimeAsync(INBOUND_TURN_TIMEOUT_MS - 1)
      expect(client.inbound?.reportInboundEventResult).not.toHaveBeenCalled()
      expect(signal?.aborted).toBe(false)
      expect(gateway.activity().active).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal?.aborted).toBe(true)
      await until(() => scheduled(gateway) === 1)
      await vi.advanceTimersByTimeAsync(0)
      await until(async () => (await queued(stateDir)) === 0)
      expect(client.inbound?.reportInboundEventResult).toHaveBeenCalledWith(
        'deepseek-agent',
        SOURCE_ID,
        'inbev_stuck',
        expect.objectContaining({ status: 'failed', error: 'Agent turn did not finish within 30 minutes' }),
      )
    } finally {
      await gateway.close()
    }
  })

  it('reports a failed turn on script output without running the script again', async () => {
    const { gateway, stateDir, client } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockRejectedValue(new Error('model unavailable'))
    try {
      const command = 'echo run >> attempts; echo summary'
      await gateway.handleRequest(inbound('inbev_outfail', { type: 'script', command }))
      await until(async () => (await queued(stateDir)) === 0)
      expect(await readFile(join(stateDir, 'attempts'), 'utf8')).toBe('run\n')
      expect(run).toHaveBeenCalledOnce()
      expect(client.inbound?.reportInboundEventResult).toHaveBeenCalledWith(
        'deepseek-agent',
        SOURCE_ID,
        'inbev_outfail',
        expect.objectContaining({ status: 'failed', error: 'model unavailable' }),
      )
    } finally {
      await gateway.close()
    }
  })

  it('answers 503 without acknowledging once the inbound queue is full', async () => {
    const { gateway } = await harness()
    vi.spyOn(gateway.agents, 'run').mockImplementation(
      (_route, _prompt, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)),
        ),
    )
    try {
      for (let index = 0; index < INBOUND_MAX_PENDING_EVENTS; index++)
        expect(
          (await gateway.handleRequest(inbound(`inbev_q${String(index).padStart(6, '0')}`))).status,
        ).toBe(202)
      const overflow = inbound('inbev_overflow')
      const id = await trackingId(overflow)
      expect((await gateway.handleRequest(overflow)).status).toBe(503)
      expect(gateway.eventState(id)).toBe('absent')
      expect((await gateway.handleRequest(inbound('inbev_q000000'))).status).toBe(200)
    } finally {
      await gateway.close()
    }
  })

  it('reports a full queue through inboundAdmits and stores a host-acknowledged delivery', async () => {
    const { gateway } = await harness()
    gateway.externalAdmission = true
    vi.spyOn(gateway.agents, 'run').mockImplementation(
      (_route, _prompt, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)),
        ),
    )
    try {
      for (let index = 0; index < INBOUND_MAX_PENDING_EVENTS; index++)
        await gateway.handleRequest(inbound(`inbev_q${String(index).padStart(6, '0')}`))
      const overflow = inbound('inbev_overflow')
      const payload = await overflow.clone().json()
      expect(gateway.inboundAdmits(await inbound('inbev_q000000').json())).toBe(true)
      expect(gateway.inboundAdmits(payload)).toBe(false)
      expect((await gateway.handleRequest(overflow)).status).toBe(202)
      expect(gateway.eventState(await trackingId(inbound('inbev_overflow')))).toBe('completed')
    } finally {
      await gateway.close()
    }
  })

  it('runs at most four inbound scripts at once across sources', async () => {
    const { gateway, stateDir } = await harness()
    await mkdir(join(stateDir, 'running'))
    const command = 'touch "running/$$"; ls running | wc -l >> counts; sleep 0.3; rm "running/$$"'
    try {
      for (let index = 0; index < 6; index++) {
        const body = await inbound(`inbev_c${index}`, { type: 'script', command }).json()
        body.data.source.id = `inbsrc_${index}`
        const request = new Request('http://127.0.0.1/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-signature': 'signed' },
          body: JSON.stringify(body),
        })
        expect((await gateway.handleRequest(request)).status).toBe(202)
      }
      await until(async () => (await queued(stateDir)) === 0)
      const counts = (await readFile(join(stateDir, 'counts'), 'utf8')).trim().split('\n').map(Number)
      expect(counts).toHaveLength(6)
      expect(Math.max(...counts)).toBeLessThanOrEqual(4)
    } finally {
      await gateway.close()
    }
  })

  it('stops a running inbound script on close without starting a turn', async () => {
    const { gateway, stateDir } = await harness()
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('done')
    const command = 'touch started; sleep 30; echo summary'
    await gateway.handleRequest(inbound('inbev_closing', { type: 'script', command }))
    await until(async () => (await readdir(stateDir)).includes('started'))
    const started = Date.now()
    await gateway.close()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(run).not.toHaveBeenCalled()
    expect(await queued(stateDir)).toBe(1)
  })

  it('keeps a queued event a read error skipped and runs it once readable', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-gateway-'))
    const request = inbound('inbev_unreadable')
    const event = parseInbound(await request.clone().json())
    if (!event) throw new Error('unparsed')
    const store = new InboundStore(join(stateDir, 'inbound'))
    await store.save({ trackingId: await trackingId(request), event, attempts: 0, dueAt: 0 })
    const [file = ''] = (await readdir(join(stateDir, 'inbound'))).filter((name) => name.endsWith('.json'))
    await chmod(join(stateDir, 'inbound', file), 0)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { gateway } = await harness(0, 'inkbox_voice_ai', {}, [], false, stateDir)
    const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('done')
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(run).not.toHaveBeenCalled()
      expect(await queued(stateDir)).toBe(1)
      await chmod(join(stateDir, 'inbound', file), 0o600)
      await vi.advanceTimersByTimeAsync(INBOUND_RELOAD_DELAY_MS)
      await until(() => scheduled(gateway) === 1)
      await vi.advanceTimersByTimeAsync(0)
      await until(async () => (await queued(stateDir)) === 0)
      expect(run).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      await gateway.close()
    }
  })

  it('does not re-queue a job that finished while the queue was reloading', async () => {
    const { gateway, stateDir } = await harness()
    let release = () => {}
    const run = vi
      .spyOn(gateway.agents, 'run')
      .mockImplementation(() => new Promise((resolve) => (release = () => resolve('done'))))
    try {
      await gateway.handleRequest(inbound('inbev_reload'))
      await until(() => run.mock.calls.length === 1)
      const internals = gateway as unknown as {
        inboundStore: InboundStore
        loadInbound(schedule: boolean): Promise<void>
      }
      const stale = await internals.inboundStore.load()
      vi.spyOn(internals.inboundStore, 'load').mockImplementation(async () => {
        release()
        await until(async () => (await queued(stateDir)) === 0)
        return { items: stale.items, unreadable: 0 }
      })
      await internals.loadInbound(true)
      expect(scheduled(gateway)).toBe(0)
      expect(run).toHaveBeenCalledOnce()
    } finally {
      await gateway.close()
    }
  })

  it('reports an agent turn interrupted by a restart instead of repeating it', async () => {
    const first = await harness()
    const run = vi.spyOn(first.gateway.agents, 'run').mockImplementation(() => new Promise(() => {}))
    await first.gateway.handleRequest(inbound('inbev_interrupted'))
    await until(() => run.mock.calls.length === 1)
    // The first gateway is left mid-turn, as after a crash.

    const second = await harness(0, 'inkbox_voice_ai', {}, [], false, first.stateDir)
    const rerun = vi.spyOn(second.gateway.agents, 'run')
    try {
      await until(async () => (await queued(first.stateDir)) === 0)
      expect(rerun).not.toHaveBeenCalled()
      expect(second.client.inbound?.reportInboundEventResult).toHaveBeenCalledWith(
        'deepseek-agent',
        SOURCE_ID,
        'inbev_interrupted',
        expect.objectContaining({ status: 'failed', error: 'Agent turn was interrupted by a restart' }),
      )
    } finally {
      await second.gateway.close()
    }
  })

  it.each([
    [400, false],
    [404, false],
    [409, false],
    [408, true],
    [429, true],
    [500, true],
  ])('ends report retries on HTTP %s unless retryable (%s)', async (status, retried) => {
    const { gateway, stateDir, client } = await harness()
    vi.spyOn(gateway.agents, 'run').mockRejectedValue(new Error('model unavailable'))
    client.inbound?.reportInboundEventResult.mockRejectedValue(new InkboxAPIError(status, 'error'))
    try {
      await gateway.handleRequest(inbound('inbev_status'))
      await until(() => (client.inbound?.reportInboundEventResult.mock.calls.length ?? 0) === 1)
      if (retried) {
        await until(() => scheduled(gateway) === 1)
        // A pending failure report does not keep the gateway awake.
        expect(gateway.activity().active).toBe(0)
        expect(await queued(stateDir)).toBe(1)
      } else await until(async () => (await queued(stateDir)) === 0)
    } finally {
      await gateway.close()
    }
  })

  it('resumes queued work and pending reports after a restart without running a finished script again', async () => {
    const first = await harness()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const command = 'echo run >> attempts; exit 1'
    const request = inbound('inbev_restart', { type: 'script', command })
    const deliveryId = JSON.parse(await request.clone().text()).data.delivery_id
    expect((await first.gateway.handleRequest(request)).status).toBe(202)
    await vi.advanceTimersByTimeAsync(0)
    const attempts = async () =>
      (await readFile(join(first.stateDir, 'attempts'), 'utf8').catch(() => '')).split('\n').length - 1
    await until(async () => (await attempts()) === 1)
    await until(() => scheduled(first.gateway) === 1)
    await first.gateway.close()

    let second = await harness(0, 'inkbox_voice_ai', {}, [], false, first.stateDir)
    try {
      expect(
        (await second.gateway.handleRequest(inbound('inbev_restart', { type: 'script', command }))).status,
      ).toBe(200)
      expect(second.gateway.activity().active).toBe(1)
      second.client.inbound?.reportInboundEventResult.mockRejectedValue(
        new InkboxAPIError(503, 'unavailable'),
      )
      for (const [index, delay] of [10_000, 30_000, 120_000, 600_000].entries()) {
        await vi.advanceTimersByTimeAsync(delay)
        await until(async () => (await attempts()) === index + 2)
        await until(() => scheduled(second.gateway) === 1)
      }
      await vi.advanceTimersByTimeAsync(0)
      await until(() => (second.client.inbound?.reportInboundEventResult.mock.calls.length ?? 0) === 1)
      await until(() => scheduled(second.gateway) === 1)
      expect(await attempts()).toBe(5)
      expect(await queued(first.stateDir)).toBe(1)
      await second.gateway.close()

      second = await harness(0, 'inkbox_voice_ai', {}, [], false, first.stateDir)
      second.client.inbound?.reportInboundEventResult.mockRejectedValue(
        new InkboxAPIError(409, 'stale_delivery'),
      )
      await vi.advanceTimersByTimeAsync(3_600_000)
      await until(async () => (await queued(first.stateDir)) === 0)
      expect(second.client.inbound?.reportInboundEventResult).toHaveBeenCalledWith(
        'deepseek-agent',
        SOURCE_ID,
        'inbev_restart',
        { status: 'failed', error: 'Exited with code 1', deliveryId },
      )
      expect(await attempts()).toBe(5)
    } finally {
      vi.useRealTimers()
      await second.gateway.close()
    }
  })
})
