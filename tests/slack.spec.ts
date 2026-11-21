import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { type AgentIdentity, Inkbox, InkboxAPIError } from '@inkbox/sdk'
import type { TunnelListener } from '@inkbox/sdk/tunnels/connect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { Gateway } from '../src/gateway.js'
import { routeSlack } from '../src/routing.js'
import type { InkboxRuntime } from '../src/runtime.js'
import {
  parseSlack,
  SLACK_EVENTS,
  SLACK_STOP,
  SLACK_SUBSCRIPTION_EVENTS,
  SlackConnectionDenied,
  sendSlackReply,
} from '../src/slack.js'
import { configureSlack } from '../src/slack-setup.js'
import { VoiceNoteNotAdmitted } from '../src/voice-notes.js'

const tunnel = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('@inkbox/sdk/tunnels/connect', () => ({ connect: tunnel.connect }))

const URL = 'https://agent.example.test/webhook'
const FINISHED = 'message.transcription_finished'
const SLACK = [...SLACK_EVENTS]
const SUBSCRIBED = [...SLACK_SUBSCRIPTION_EVENTS]

interface Row {
  id: string
  url: string
  eventTypes: string[]
  status: string
  agentIdentityId?: string
  mailboxId?: string
  phoneNumberId?: string
}

/** The server lets one active subscription per URL hold each event. */
function server(seed: Omit<Row, 'status'>[] = [], unsupportedTranscription = false) {
  const rows: Row[] = seed.map((row) => ({ ...row, eventTypes: [...row.eventTypes], status: 'active' }))
  const conflict = (candidate: Row) => {
    if (
      unsupportedTranscription &&
      candidate.eventTypes.includes(FINISHED) &&
      !rows.some((row) => row.id === candidate.id && row.eventTypes.includes(FINISHED))
    )
      throw Object.assign(new InkboxAPIError(422, 'Unknown event'), {
        detail: [
          {
            type: 'enum',
            loc: ['body', 'event_types', candidate.eventTypes.indexOf(FINISHED)],
            input: FINISHED,
          },
        ],
      })
    if (
      rows.some(
        (row) =>
          row.id !== candidate.id &&
          row.url === candidate.url &&
          row.status === 'active' &&
          row.eventTypes.some((event) => candidate.eventTypes.includes(event)),
      )
    )
      throw new InkboxAPIError(409, 'Subscription already exists')
  }
  let created = 0
  const subscriptions = {
    list: vi.fn(async (filter: Partial<Row>) =>
      rows
        .filter(
          (row) =>
            (filter.mailboxId === undefined || row.mailboxId === filter.mailboxId) &&
            (filter.phoneNumberId === undefined || row.phoneNumberId === filter.phoneNumberId) &&
            (filter.agentIdentityId === undefined || row.agentIdentityId === filter.agentIdentityId) &&
            (filter.url === undefined || row.url === filter.url),
        )
        .map((row) => ({ ...row, eventTypes: [...row.eventTypes] })),
    ),
    create: vi.fn(async (options: Omit<Row, 'id' | 'status'>) => {
      const row = {
        ...options,
        eventTypes: [...options.eventTypes],
        id: `created-${++created}`,
        status: 'active',
      }
      conflict(row)
      rows.push(row)
      return { ...row, signingKey: null }
    }),
    update: vi.fn(async (id: string, options: { eventTypes: string[] }) => {
      const row = rows.find((candidate) => candidate.id === id)
      if (!row) throw new InkboxAPIError(404, 'Not found')
      conflict({ ...row, eventTypes: options.eventTypes })
      row.eventTypes = [...options.eventTypes]
      return row
    }),
    delete: vi.fn(async (id: string) => {
      const index = rows.findIndex((row) => row.id === id)
      if (index < 0) throw new InkboxAPIError(404, 'Not found')
      rows.splice(index, 1)
    }),
  }
  const holders = () => rows.filter((row) => row.url === URL && row.eventTypes.includes(FINISHED))
  const clear = () => {
    for (const fn of Object.values(subscriptions)) fn.mockClear()
  }
  return { rows, subscriptions, holders, clear }
}

const connection = {
  id: 'connection-1',
  identityId: 'identity-1',
  workspaceId: 'T1',
  workspaceName: 'Workspace',
  botUserId: 'UBOT',
  status: 'connected',
  scopes: [],
  createdAt: new Date(),
  generation: 3,
}

async function harness(
  options: { slackEnabled?: boolean; backend?: ReturnType<typeof server>; stateDir?: string } = {},
) {
  const stateDir = options.stateDir ?? (await mkdtemp(join(tmpdir(), 'inkbox-slack-')))
  const backend = options.backend ?? server()
  const slack = {
    listConnections: vi.fn(async () => ({ connections: [connection], installationAvailable: true })),
    sendMessage: vi.fn(async (_connectionId: string, request: { conversationId: string }) => ({
      id: 'action-1',
      connectionId: 'connection-1',
      status: 'sent',
      conversationId: request.conversationId,
    })),
  }
  const client = { webhooks: { subscriptions: backend.subscriptions }, slack }
  const identity = {
    id: 'identity-1',
    agentHandle: 'deepseek-agent',
    mailbox: null,
    phoneNumber: null,
    sendText: vi.fn(async () => ({ id: 'text-1' })),
    sendWhatsApp: vi.fn(async () => ({ id: 'whatsapp-1' })),
  }
  const runtime = {
    getClient: vi.fn(async () => client as unknown as Inkbox),
    getIdentity: vi.fn(async () => identity as unknown as AgentIdentity),
    resolveSigningKey: vi.fn(async () => 'test-signing-key'),
  } as unknown as InkboxRuntime
  const config: ResolvedConfig = {
    enabled: true,
    workspace: stateDir,
    agentHandle: 'deepseek-agent',
    credentialRef: 'INKBOX_API_KEY',
    signingKeyRef: 'INKBOX_WEBHOOK_SIGNING_KEY',
    githubWebhookSecretRef: 'INKBOX_WEBHOOK_SECRET_GITHUB',
    stateDir,
    batchWindowMs: 0,
    permissionTimeoutMs: 2_000,
    autoApproveInkboxTools: false,
    externalEvents: false,
    slackEnabled: options.slackEnabled ?? true,
    voiceEnabled: true,
    voiceStack: 'inkbox_voice_ai',
    realtimeCredentialRef: 'INKBOX_REALTIME_API_KEY',
    realtimeModel: 'gpt-realtime-2',
    realtimeVoice: 'cedar',
    channelInstructions: {},
  }
  const ctx = { credentials: { set: vi.fn(async () => {}) } } as unknown as Context
  const gateway = new Gateway(ctx, runtime, config, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  await gateway.start()
  const run = vi.spyOn(gateway.agents, 'run').mockResolvedValue('Reply from DeepSeek')
  return { gateway, backend, slack, run, stateDir, identity }
}

function message(
  overrides: {
    id?: string
    type?: string
    data?: Record<string, unknown>
    event?: Record<string, unknown>
  } = {},
): Record<string, unknown> {
  const type = overrides.type ?? 'slack.dm_received'
  const kinds: Record<string, string[]> = {
    'slack.dm_received': ['dm'],
    'slack.group_dm_received': ['group_dm'],
    'slack.channel_message_received': ['channel'],
    'slack.mention_received': ['mention'],
    'slack.thread_reply_received': ['thread'],
  }
  return {
    id: overrides.id ?? 'event-1',
    event_type: type,
    data: {
      identity_id: 'identity-1',
      connection_id: 'connection-1',
      workspace_id: 'T1',
      conversation_id: type === 'slack.dm_received' ? 'D1' : 'C1',
      actor_id: 'U1',
      message_ts: '1770000000.000100',
      thread_ts: null,
      message_id: 'slack-message-1',
      message_kinds: kinds[type],
      sender_access: 'direct',
      contact_id: 'contact-1',
      event: { type: 'message', text: 'Hello from Slack', ...overrides.event },
      ...overrides.data,
    },
  }
}

beforeEach(() => {
  tunnel.connect.mockReset()
  tunnel.connect.mockImplementation(async (_client, options) => {
    options.onStatus?.('connected')
    return {
      publicUrl: 'https://agent.example.test',
      isConnected: true,
      wait: () => new Promise<void>(() => {}),
      aclose: vi.fn(async () => {}),
    } as unknown as TunnelListener
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const ROOT = '1770000000.000100'
const THREAD_ROUTE = `slack:${JSON.stringify(['identity-1', 'connection-1', 'C1', ROOT])}`
const mention = () => message({ type: 'slack.mention_received', event: { text: '<@UBOT> deploy it' } })
const threadReply = (id: string, actor: string, messageId: string, text: string) =>
  message({
    id,
    type: 'slack.thread_reply_received',
    data: {
      actor_id: actor,
      message_id: messageId,
      message_ts: `177000000${id.length}.000200`,
      thread_ts: ROOT,
    },
    event: { text },
  })
const stop = (id: string, actor: string) => ({
  id,
  event_type: SLACK_STOP,
  data: {
    identity_id: 'identity-1',
    connection_id: 'connection-1',
    workspace_id: 'T1',
    conversation_id: 'C1',
    actor_id: actor,
    thread_ts: ROOT,
    event: { type: 'agent_session_stopped' },
  },
})
const savedReply = (nextAttemptAt = Date.now()) => ({
  state: 'ready' as const,
  eventIds: ['saved-event'],
  target: {
    channel: 'slack' as const,
    identityId: 'identity-1',
    connectionId: 'connection-1',
    workspaceId: 'T1',
    conversationId: 'C1',
    threadTs: ROOT,
    sourceEventId: 'saved-event',
  },
  response: 'Saved answer',
  attempts: 0,
  nextAttemptAt,
})

describe('Slack subscription', () => {
  async function startTwice(backend: ReturnType<typeof server>) {
    const first = await harness({ backend })
    await first.gateway.close()
    const held = backend.holders()
    expect(held).toHaveLength(1)
    expect(held[0]?.eventTypes.some((event) => event.startsWith('slack.'))).toBe(true)
    const covered = backend.rows.filter((row) => row.url === URL).flatMap((row) => row.eventTypes)
    expect(covered).toEqual(expect.arrayContaining(SUBSCRIBED))
    const snapshot = JSON.stringify(backend.rows)
    backend.clear()
    const second = await harness({ backend })
    await second.gateway.close()
    expect(JSON.stringify(backend.rows)).toBe(snapshot)
    expect(backend.subscriptions.create).not.toHaveBeenCalled()
    expect(backend.subscriptions.update).not.toHaveBeenCalled()
    expect(backend.subscriptions.delete).not.toHaveBeenCalled()
  }

  it('moves the completion event onto the Slack row on a fresh install, stable on restart', async () => {
    const backend = server()
    await startTwice(backend)
    const slackRows = backend.rows.filter((row) => row.eventTypes.some((event) => event.startsWith('slack.')))
    expect(slackRows).toHaveLength(1)
    expect(slackRows[0]?.eventTypes).toEqual(expect.arrayContaining([...SUBSCRIBED, FINISHED]))
  })

  it('removes a standalone completion row on upgrade and adopts the Slack row', async () => {
    const backend = server([
      { id: 'completions', agentIdentityId: 'identity-1', url: URL, eventTypes: [FINISHED] },
      { id: 'slack', agentIdentityId: 'identity-1', url: URL, eventTypes: SLACK },
    ])
    await startTwice(backend)
    expect(backend.rows.some((row) => row.id === 'completions')).toBe(false)
    expect(backend.holders()[0]?.id).toBe('slack')
    expect(backend.holders()[0]?.eventTypes).toEqual(expect.arrayContaining(SUBSCRIBED))
  })

  it('chooses one target when two Slack rows exist and keeps the other row intact', async () => {
    const backend = server([
      {
        id: 'completions',
        agentIdentityId: 'identity-1',
        url: URL,
        eventTypes: [FINISHED, 'whatsapp.received'],
      },
      {
        id: 'slack-a',
        agentIdentityId: 'identity-1',
        url: URL,
        eventTypes: ['slack.dm_received', 'slack.group_dm_received', 'slack.channel_message_received'],
      },
      {
        id: 'slack-b',
        agentIdentityId: 'identity-1',
        url: URL,
        eventTypes: ['slack.mention_received', 'slack.thread_reply_received'],
      },
    ])
    await startTwice(backend)
    expect(backend.holders()[0]?.id).toBe('slack-a')
    expect(backend.rows.find((row) => row.id === 'slack-b')?.eventTypes).toEqual([
      'slack.mention_received',
      'slack.thread_reply_received',
    ])
    expect(backend.rows.find((row) => row.id === 'completions')?.eventTypes).toEqual(['whatsapp.received'])
  })

  it('keeps Slack messages flowing when the server rejects the completion event', async () => {
    const backend = server([], true)
    const { gateway } = await harness({ backend })
    try {
      expect(gateway.status()).toMatchObject({ ready: true, slack: 'connected' })
      const slackRows = backend.rows.filter((row) =>
        row.eventTypes.some((event) => event.startsWith('slack.')),
      )
      expect(slackRows).toHaveLength(1)
      expect(slackRows[0]?.eventTypes).toEqual(SUBSCRIBED)
      expect(backend.holders()).toHaveLength(0)
    } finally {
      await gateway.close()
    }
  })

  it('registers no Slack events and handles no Slack message when Slack is disabled', async () => {
    const { gateway, backend, slack, run, stateDir } = await harness({ slackEnabled: false })
    try {
      expect(gateway.status().slack).toBe('disabled')
      expect(backend.rows.some((row) => row.eventTypes.some((event) => event.startsWith('slack.')))).toBe(
        false,
      )
      expect(backend.holders().map((row) => row.eventTypes)).toEqual([[FINISHED]])
      const voice = message({
        event: { files: [{ id: 'F1', transcription: { status: 'pending' } }] },
      })
      expect((await gateway.dispatchVerified(voice, 'inkbox')).status).toBe(202)
      expect((await gateway.dispatchVerified(message({ id: 'event-2' }), 'inkbox')).status).toBe(202)
      expect(existsSync(join(stateDir, 'voice-notes-identity-1.json'))).toBe(false)
      expect(slack.listConnections).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })
})

describe('Slack reception and replies', () => {
  it('routes a DM to the contact session and replies in the same conversation', async () => {
    const { gateway, run, slack } = await harness()
    try {
      expect((await gateway.dispatchVerified(message(), 'inkbox')).status).toBe(202)
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      expect(run).toHaveBeenCalledWith('contact:contact-1', expect.stringContaining('Channel: slack'), {
        signal: expect.any(AbortSignal),
      })
      expect(run.mock.calls[0]?.[1]).toContain('Hello from Slack')
      expect(run.mock.calls[0]?.[1]).toContain('[inkbox:slack from=T1:U1 connection_id=connection-1')
      expect(slack.sendMessage).toHaveBeenCalledWith('connection-1', {
        conversationId: 'D1',
        threadTs: null,
        text: 'Reply from DeepSeek',
        idempotencyKey: expect.stringMatching(/^deepseek:[0-9a-f]{64}$/),
      })
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('completed'))
    } finally {
      await gateway.close()
    }
  })

  it('deduplicates redeliveries and other envelopes for the same Slack message', async () => {
    const { gateway, run, slack } = await harness()
    try {
      expect((await gateway.dispatchVerified(message(), 'inkbox')).status).toBe(202)
      expect((await gateway.dispatchVerified(message(), 'inkbox')).status).toBe(200)
      const other = message({ id: 'event-2', type: 'slack.mention_received' })
      ;(other.data as Record<string, unknown>).conversation_id = 'D1'
      expect((await gateway.dispatchVerified(other, 'inkbox')).status).toBe(200)
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      expect(run).toHaveBeenCalledTimes(1)
      expect(gateway.eventState('event-2')).toBe('completed')
      const unretained = message({
        id: 'event-3',
        data: { message_id: undefined, message_ts: '1770000001.0' },
      })
      expect((await gateway.dispatchVerified(unretained, 'inkbox')).status).toBe(202)
      expect((await gateway.dispatchVerified(unretained, 'inkbox')).status).toBe(200)
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    } finally {
      await gateway.close()
    }
  })

  it('answers a mention in its thread and continues that thread without another mention', async () => {
    const { gateway, run, slack } = await harness()
    try {
      const mention = message({
        type: 'slack.mention_received',
        event: { text: '<@UBOT> what changed?' },
      })
      expect((await gateway.dispatchVerified(mention, 'inkbox')).status).toBe(202)
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      const routeKey = run.mock.calls[0]?.[0]
      expect(routeKey).toBe(
        `slack:${JSON.stringify(['identity-1', 'connection-1', 'C1', '1770000000.000100'])}`,
      )
      expect(run.mock.calls[0]?.[1]).toContain('[inkbox:group_slack from=T1:U1')
      expect(slack.sendMessage.mock.calls[0]?.[1]).toMatchObject({
        conversationId: 'C1',
        threadTs: '1770000000.000100',
      })
      const quiet = message({
        id: 'event-quiet',
        type: 'slack.channel_message_received',
        data: { message_id: 'slack-message-2', message_ts: '1770000002.000100' },
      })
      expect((await gateway.dispatchVerified(quiet, 'inkbox')).status).toBe(202)
      const reply = message({
        id: 'event-thread',
        type: 'slack.thread_reply_received',
        data: {
          message_id: 'slack-message-3',
          message_ts: '1770000003.000100',
          thread_ts: '1770000000.000100',
        },
        event: { text: 'and the tests?' },
      })
      expect((await gateway.dispatchVerified(reply, 'inkbox')).status).toBe(202)
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      expect(run.mock.calls[1]?.[0]).toBe(routeKey)
      expect(gateway.eventState('event-quiet')).toBe('absent')
    } finally {
      await gateway.close()
    }
  })

  it('ignores bot, sponsored, and other-identity senders', async () => {
    const { gateway, run, slack } = await harness()
    try {
      for (const event of [
        message({ id: 'bot', event: { bot_id: 'B1' } }),
        message({ id: 'sponsored', data: { sender_access: 'sponsored' } }),
        message({ id: 'other', data: { identity_id: 'identity-2' } }),
      ])
        expect((await gateway.dispatchVerified(event, 'inkbox')).status).toBe(202)
      expect(slack.listConnections).toHaveBeenCalledTimes(1)
      expect(run).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })

  it('leaves a message unadmitted after a temporary connection read failure only', async () => {
    const { gateway, run, slack } = await harness()
    try {
      for (const status of [408, 429, 503]) {
        slack.listConnections.mockRejectedValueOnce(new InkboxAPIError(status, 'temporary'))
        await expect(
          gateway.dispatchVerified(message({ id: `event-${status}` }), 'inkbox'),
        ).rejects.toBeInstanceOf(VoiceNoteNotAdmitted)
      }
      slack.listConnections.mockRejectedValueOnce(new InkboxAPIError(403, 'forbidden'))
      const final = gateway.dispatchVerified(message({ id: 'event-403' }), 'inkbox')
      await expect(final).rejects.toBeInstanceOf(InkboxAPIError)
      await expect(final).rejects.not.toBeInstanceOf(VoiceNoteNotAdmitted)
      slack.listConnections.mockResolvedValueOnce({ connections: [], installationAvailable: true })
      await expect(
        gateway.dispatchVerified(message({ id: 'event-denied' }), 'inkbox'),
      ).rejects.toBeInstanceOf(SlackConnectionDenied)
      expect(run).not.toHaveBeenCalled()
      expect((await gateway.dispatchVerified(message({ id: 'event-retry' }), 'inkbox')).status).toBe(202)
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    } finally {
      await gateway.close()
    }
  })

  it('withholds a reply whose send outcome is not confirmed instead of resending it', async () => {
    const { gateway, slack } = await harness()
    try {
      slack.sendMessage.mockResolvedValueOnce({
        id: 'action-unknown',
        connectionId: 'connection-1',
        status: 'unknown',
        conversationId: 'D1',
      })
      await gateway.dispatchVerified(message(), 'inkbox')
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('uncertain'))
      gateway.resumeDeliveries()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(slack.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await gateway.close()
    }
  })
})

describe('Slack voice-note wait', () => {
  const pending = (id = 'event-voice') =>
    message({
      id,
      event: { text: '', files: [{ id: 'F1', name: 'voice.m4a', transcription: { status: 'pending' } }] },
    })
  const finished = {
    id: 'event-finished',
    event_type: FINISHED,
    data: {
      ...(message().data as Record<string, unknown>),
      channel: 'slack',
      event: {
        type: 'message',
        text: '',
        files: [
          {
            id: 'F1',
            name: 'voice.m4a',
            transcription: { status: 'completed', text: 'Move the review to Thursday.' },
          },
        ],
      },
    },
  }

  it.each([
    ['after', false],
    ['before', true],
  ])(
    'wakes once with the labeled transcript when the completion arrives %s the original',
    async (_, early) => {
      const { gateway, run, slack } = await harness()
      try {
        if (early) expect((await gateway.dispatchVerified(finished, 'inkbox')).status).toBe(202)
        expect((await gateway.dispatchVerified(pending(), 'inkbox')).status).toBe(202)
        if (!early) {
          expect(run).not.toHaveBeenCalled()
          await gateway.dispatchVerified(finished, 'inkbox')
        }
        await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
        expect(run).toHaveBeenCalledTimes(1)
        expect(run.mock.calls[0]?.[1]).toContain(
          '[Voice note 1 — automatically transcribed]\nMove the review to Thursday.',
        )
        await gateway.dispatchVerified(finished, 'inkbox')
        await gateway.dispatchVerified(pending('event-voice-again'), 'inkbox')
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(run).toHaveBeenCalledTimes(1)
      } finally {
        await gateway.close()
      }
    },
  )

  it('labels the transcript as content and never as a typed approval answer', () => {
    const received = { ...pending(), data: finished.data, event_type: 'slack.dm_received' }
    const route = parseSlack(received, 'identity-1')
    if (!route) throw new Error('Slack message was not parsed')
    const routed = routeSlack(received, route, '', 'routing-key-routing-key-routing-key')
    expect(routed.content).toContain(
      '[Voice note 1 — automatically transcribed]\nMove the review to Thursday.',
    )
    expect(routed.replyText).toBe('')
  })
})

describe('Slack approvals, stop and saved replies', () => {
  /** Holds each mocked turn open until released, recording the abort signal it was given. */
  function heldTurns(run: Awaited<ReturnType<typeof harness>>['run']) {
    const turns: { prompt: string; signal: AbortSignal | undefined; release(value?: string): void }[] = []
    run.mockImplementation(
      (_routeKey, prompt, options) =>
        new Promise<string>((resolve) => {
          turns.push({
            prompt,
            signal: options?.signal,
            release: (value = 'Reply from DeepSeek') => resolve(value),
          })
        }),
    )
    return turns
  }

  it('binds an approval to the participant who started the turn, not a later poster', async () => {
    const { gateway, run, slack } = await harness()
    try {
      const turns = heldTurns(run)
      const steer = vi.spyOn(gateway.agents, 'steer')
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      // Another participant posts while the turn is generating: it becomes a separate turn.
      await gateway.dispatchVerified(
        threadReply('event-u2-note', 'U2', 'slack-message-2', 'me too'),
        'inkbox',
      )
      expect(steer).not.toHaveBeenCalled()
      vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue(THREAD_ROUTE)
      const approval = gateway.askApproval({} as Agent, 'Deploy to production')
      let settled = false
      void approval.then(() => {
        settled = true
      })
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      expect(slack.sendMessage.mock.calls[0]?.[1]).toMatchObject({
        threadTs: ROOT,
        text: expect.stringContaining('Reply YES'),
      })
      await gateway.dispatchVerified(threadReply('event-u2-yes', 'U2', 'slack-message-3', 'YES'), 'inkbox')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      await gateway.dispatchVerified(threadReply('event-u1-yes', 'U1', 'slack-message-4', 'YES'), 'inkbox')
      await expect(approval).resolves.toBe('allowed-once')
      turns[0]?.release()
      // The later poster's messages run afterwards as their own turns.
      await vi.waitFor(() => expect(turns).toHaveLength(2))
      expect(turns[1]?.prompt).toContain('me too')
      turns[1]?.release()
      await vi.waitFor(() => expect(turns).toHaveLength(3))
      turns[2]?.release()
    } finally {
      await gateway.close()
    }
  })

  it("ignores another participant's stop and stops the owner's running turn without a reply", async () => {
    const { gateway, run, slack } = await harness()
    try {
      const turns = heldTurns(run)
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      expect(run.mock.calls[0]?.[0]).toBe(THREAD_ROUTE)
      await gateway.dispatchVerified(
        threadReply('event-u2-note', 'U2', 'slack-message-2', 'me too'),
        'inkbox',
      )
      expect((await gateway.dispatchVerified(stop('stop-u2', 'U2'), 'inkbox')).status).toBe(202)
      expect(turns[0]?.signal?.aborted).toBe(false)
      expect((await gateway.dispatchVerified(stop('stop-u1', 'U1'), 'inkbox')).status).toBe(202)
      expect(turns[0]?.signal?.aborted).toBe(true)
      turns[0]?.release('Partial answer')
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('completed'))
      // The other participant stopped only their own queued message.
      expect(gateway.eventState('event-u2-note')).toBe('completed')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(turns).toHaveLength(1)
      expect(slack.sendMessage).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })

  it('reuses a redelivered stop receipt and never cancels a later turn', async () => {
    const { gateway, run } = await harness()
    try {
      const turns = heldTurns(run)
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      await gateway.dispatchVerified(stop('stop-1', 'U1'), 'inkbox')
      expect(turns[0]?.signal?.aborted).toBe(true)
      turns[0]?.release()
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('completed'))
      await gateway.dispatchVerified(
        threadReply('event-next', 'U1', 'slack-message-5', 'try again'),
        'inkbox',
      )
      await vi.waitFor(() => expect(turns).toHaveLength(2))
      expect((await gateway.dispatchVerified(stop('stop-1', 'U1'), 'inkbox')).status).toBe(202)
      expect(turns[1]?.signal?.aborted).toBe(false)
      expect(gateway.state.snapshot().slackStops['slack-stop:identity-1:stop-1']?.targets).toEqual([
        'event-1',
      ])
      turns[1]?.release()
      await vi.waitFor(() => expect(gateway.eventState('event-next')).toBe('completed'))
    } finally {
      await gateway.close()
    }
  })

  it('submits nothing when a stop arrives before the agent is acquired', async () => {
    const { gateway, run, slack } = await harness()
    try {
      run.mockRestore()
      let acquire: (agent: Agent) => void = () => {}
      const get = vi.spyOn(gateway.agents, 'get').mockImplementation(
        () =>
          new Promise<Agent>((resolve) => {
            acquire = resolve
          }),
      )
      const followup = vi.fn()
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
      await gateway.dispatchVerified(stop('stop-early', 'U1'), 'inkbox')
      acquire({ whenIdle: async () => {}, followup, session: { seq: 0, events: [] } } as unknown as Agent)
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('completed'))
      expect(followup).not.toHaveBeenCalled()
      expect(slack.sendMessage).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })

  it('runs a message sent after a stop as a new turn', async () => {
    const { gateway, run, slack } = await harness()
    try {
      const turns = heldTurns(run)
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      await gateway.dispatchVerified(stop('stop-1', 'U1'), 'inkbox')
      await gateway.dispatchVerified(
        threadReply('event-after', 'U1', 'slack-message-6', 'actually, continue'),
        'inkbox',
      )
      turns[0]?.release()
      await vi.waitFor(() => expect(turns).toHaveLength(2))
      expect(turns[1]?.prompt).toContain('actually, continue')
      expect(turns[1]?.signal?.aborted).toBe(false)
      turns[1]?.release('Continuing')
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      expect(slack.sendMessage.mock.calls[0]?.[1]).toMatchObject({ text: 'Continuing', threadTs: ROOT })
    } finally {
      await gateway.close()
    }
  })

  it('keeps a Slack-owned turn on Slack when an SMS from the same contact arrives', async () => {
    const { gateway, run, slack, identity } = await harness()
    try {
      const turns = heldTurns(run)
      const steer = vi.spyOn(gateway.agents, 'steer')
      await gateway.dispatchVerified(message(), 'inkbox')
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      expect(run.mock.calls[0]?.[0]).toBe('contact:contact-1')
      const sms = {
        id: 'event-sms',
        event_type: 'text.received',
        data: {
          text_message: {
            sender_phone_number: '+15550000001',
            conversation_id: 'sms-1',
            text: 'Also by text',
          },
          contacts: [{ id: 'contact-1', address: '+15550000001' }],
        },
      }
      expect((await gateway.dispatchVerified(sms, 'inkbox')).status).toBe(202)
      expect(steer).not.toHaveBeenCalled()
      vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue('contact:contact-1')
      const approval = gateway.askApproval({} as Agent, 'Deploy to production')
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      expect(slack.sendMessage.mock.calls[0]?.[1]).toMatchObject({
        conversationId: 'D1',
        text: expect.stringContaining('Reply YES'),
      })
      expect(identity.sendText).not.toHaveBeenCalled()
      await gateway.dispatchVerified(
        message({ id: 'event-dm-yes', data: { message_id: 'slack-message-7' }, event: { text: 'YES' } }),
        'inkbox',
      )
      await expect(approval).resolves.toBe('allowed-once')
      turns[0]?.release('Slack answer')
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(2))
      expect(slack.sendMessage.mock.calls[1]?.[1]).toMatchObject({
        conversationId: 'D1',
        text: 'Slack answer',
      })
      await vi.waitFor(() => expect(turns).toHaveLength(2))
      expect(turns[1]?.prompt).toContain('Also by text')
      turns[1]?.release('SMS answer')
      await vi.waitFor(() => expect(identity.sendText).toHaveBeenCalledTimes(1))
      expect(identity.sendText).toHaveBeenCalledWith({ conversationId: 'sms-1', text: 'SMS answer' })
      expect(slack.sendMessage).toHaveBeenCalledTimes(2)
    } finally {
      await gateway.close()
    }
  })

  it('declines a Slack approval or question with no owning turn and sends nothing', async () => {
    const { gateway, run, slack } = await harness()
    try {
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('completed'))
      expect(slack.sendMessage).toHaveBeenCalledTimes(1)
      vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue(THREAD_ROUTE)
      await expect(gateway.askApproval({} as Agent, 'Deploy to production')).resolves.toBe('rejected')
      await expect(
        gateway.askQuestions({ agent: {} as Agent, questions: [{ id: 'q1', question: 'Which region?' }] }),
      ).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] })
      expect(slack.sendMessage).toHaveBeenCalledTimes(1)
      // Another participant's YES is an ordinary message, not an approval.
      await gateway.dispatchVerified(threadReply('event-u2-yes', 'U2', 'slack-message-8', 'YES'), 'inkbox')
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
      expect(run.mock.calls[1]?.[1]).toContain('YES')
    } finally {
      await gateway.close()
    }
  })

  it("sends a running WhatsApp turn's prompt to WhatsApp when a Slack DM from the contact is waiting", async () => {
    const { gateway, run, slack, identity } = await harness()
    try {
      const turns = heldTurns(run)
      await gateway.dispatchVerified(
        {
          id: 'whatsapp-1',
          event_type: 'whatsapp.received',
          data: {
            message: { sender_number: '+15550000001', conversation_id: 'wa-1', content: 'Hello on WhatsApp' },
            contacts: [{ id: 'contact-1', address: '+15550000001' }],
          },
        },
        'inkbox',
      )
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      await gateway.dispatchVerified(message(), 'inkbox')
      vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue('contact:contact-1')
      const approval = gateway.askApproval({} as Agent, 'Send the requested message')
      await vi.waitFor(() => expect(identity.sendWhatsApp).toHaveBeenCalledOnce())
      expect(identity.sendWhatsApp).toHaveBeenCalledWith({
        conversationId: 'wa-1',
        text: expect.stringContaining('Reply YES'),
      })
      expect(slack.sendMessage).not.toHaveBeenCalled()
      await gateway.dispatchVerified(
        {
          id: 'whatsapp-yes',
          event_type: 'whatsapp.received',
          data: {
            message: { sender_number: '+15550000001', conversation_id: 'wa-1', content: 'YES' },
            contacts: [{ id: 'contact-1', address: '+15550000001' }],
          },
        },
        'inkbox',
      )
      await expect(approval).resolves.toBe('allowed-once')
      turns[0]?.release('[SILENT]')
      await vi.waitFor(() => expect(turns).toHaveLength(2))
      turns[1]?.release('Slack answer')
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      expect(slack.sendMessage.mock.calls[0]?.[1]).toMatchObject({
        conversationId: 'D1',
        text: 'Slack answer',
      })
    } finally {
      await gateway.close()
    }
  })

  it("accepts the owner's answer while the Slack prompt is still being sent, and drops a failed prompt's waiter", async () => {
    const { gateway, run, slack } = await harness()
    try {
      const turns = heldTurns(run)
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue(THREAD_ROUTE)
      let finishSend: () => void = () => {}
      slack.sendMessage.mockImplementationOnce(
        (_connectionId, request) =>
          new Promise((resolve) => {
            finishSend = () =>
              resolve({
                id: 'action-prompt',
                connectionId: 'connection-1',
                status: 'sent',
                conversationId: request.conversationId,
              })
          }),
      )
      const approval = gateway.askApproval({} as Agent, 'Deploy to production')
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(1))
      await gateway.dispatchVerified(threadReply('event-u1-yes', 'U1', 'slack-message-9', 'YES'), 'inkbox')
      finishSend()
      await expect(approval).resolves.toBe('allowed-once')
      slack.sendMessage.mockRejectedValueOnce(new InkboxAPIError(500, 'unavailable'))
      await expect(gateway.askApproval({} as Agent, 'Deploy again')).resolves.toBe('rejected')
      // The failed prompt left no waiter behind, so the next prompt is sent normally.
      const next = gateway.askApproval({} as Agent, 'Deploy once more')
      await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(3))
      await gateway.dispatchVerified(threadReply('event-u1-yes-2', 'U1', 'slack-message-10', 'YES'), 'inkbox')
      await expect(next).resolves.toBe('allowed-once')
      turns[0]?.release('[SILENT]')
    } finally {
      await gateway.close()
    }
  })

  it('posts two identical approvals in one Slack turn as two sends with different keys', async () => {
    const { gateway, run, slack } = await harness()
    try {
      const turns = heldTurns(run)
      await gateway.dispatchVerified(mention(), 'inkbox')
      await vi.waitFor(() => expect(turns).toHaveLength(1))
      vi.spyOn(gateway.agents, 'routeForAgent').mockReturnValue(THREAD_ROUTE)
      for (const [index, messageId] of ['slack-message-11', 'slack-message-12'].entries()) {
        const approval = gateway.askApproval({} as Agent, 'Deploy to production')
        await vi.waitFor(() => expect(slack.sendMessage).toHaveBeenCalledTimes(index + 1))
        await gateway.dispatchVerified(threadReply(`event-yes-${index}`, 'U1', messageId, 'YES'), 'inkbox')
        await expect(approval).resolves.toBe('allowed-once')
      }
      const [first, second] = slack.sendMessage.mock.calls.map(
        ([, request]) => request as { text?: string; idempotencyKey?: string },
      )
      expect(first?.text).toBe(second?.text)
      expect(first?.idempotencyKey).toMatch(/^deepseek:[0-9a-f]{64}$/)
      expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey)
      turns[0]?.release('[SILENT]')
    } finally {
      await gateway.close()
    }
  })

  it('records a native stop as completed, including one with nothing to stop, across a restart', async () => {
    const first = await harness()
    const turns = heldTurns(first.run)
    await first.gateway.dispatchVerified(mention(), 'inkbox')
    await vi.waitFor(() => expect(turns).toHaveLength(1))
    await first.gateway.dispatchVerified(stop('stop-active', 'U1'), 'inkbox')
    expect(first.gateway.eventState('stop-active')).toBe('completed')
    await first.gateway.dispatchVerified(stop('stop-idle', 'U3'), 'inkbox')
    expect(first.gateway.eventState('stop-idle')).toBe('completed')
    turns[0]?.release()
    await vi.waitFor(() => expect(first.gateway.eventState('event-1')).toBe('completed'))
    await first.gateway.close()
    const restarted = await harness({ stateDir: first.stateDir })
    try {
      expect(restarted.gateway.eventState('stop-active')).toBe('completed')
      expect(restarted.gateway.eventState('stop-idle')).toBe('completed')
    } finally {
      await restarted.gateway.close()
    }
  })

  it('holds a saved Slack reply while Slack is disabled and sends it once enabled again', async () => {
    const first = await harness()
    await first.gateway.state.mutate((state) => {
      state.deliveries['saved-event'] = savedReply()
    })
    await first.gateway.close()
    const disabled = await harness({ slackEnabled: false, stateDir: first.stateDir })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(disabled.slack.sendMessage).not.toHaveBeenCalled()
    expect(disabled.gateway.state.snapshot().deliveries['saved-event']?.state).toBe('ready')
    expect(disabled.gateway.eventState('saved-event')).toBe('pending')
    await disabled.gateway.close()
    const enabled = await harness({ stateDir: first.stateDir })
    try {
      await vi.waitFor(() => expect(enabled.gateway.eventState('saved-event')).toBe('completed'))
      expect(enabled.slack.sendMessage).toHaveBeenCalledTimes(1)
      expect(enabled.slack.sendMessage.mock.calls[0]?.[1]).toMatchObject({
        conversationId: 'C1',
        threadTs: ROOT,
        text: 'Saved answer',
      })
    } finally {
      await enabled.gateway.close()
    }
  })

  it('retries a temporary connection read before a reply without marking it submitted', async () => {
    const { gateway, slack } = await harness()
    try {
      slack.listConnections
        .mockResolvedValueOnce({ connections: [connection], installationAvailable: true })
        .mockRejectedValueOnce(new InkboxAPIError(503, 'unavailable'))
      await gateway.dispatchVerified(message(), 'inkbox')
      await vi.waitFor(() => expect(gateway.state.snapshot().deliveries['event-1']?.attempts).toBe(1))
      expect(gateway.state.snapshot().deliveries['event-1']?.state).toBe('ready')
      expect(slack.sendMessage).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('completed'), { timeout: 5_000 })
      expect(slack.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await gateway.close()
    }
  })

  it('refuses a saved reply without sending when the connection workspace changed', async () => {
    const { gateway, slack } = await harness()
    try {
      slack.listConnections
        .mockResolvedValueOnce({ connections: [connection], installationAvailable: true })
        .mockResolvedValueOnce({
          connections: [{ ...connection, workspaceId: 'TOTHER' }],
          installationAvailable: true,
        })
      await gateway.dispatchVerified(message(), 'inkbox')
      await vi.waitFor(() => expect(gateway.eventState('event-1')).toBe('failed'))
      expect(gateway.state.snapshot().deliveries['event-1']?.state).toBe('rejected')
      expect(slack.sendMessage).not.toHaveBeenCalled()
    } finally {
      await gateway.close()
    }
  })
})

describe('Slack contract', () => {
  const route = {
    identityId: 'identity-1',
    connectionId: 'connection-1',
    workspaceId: 'T1',
    conversationId: 'C1',
    threadTs: null,
    sourceEventId: 'event-1',
  }

  it('uses the real SDK request path with a null thread and a stable idempotency header', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        requests.push({ url: String(input), init })
        const result = String(input).includes('/messages')
          ? {
              id: 'action',
              connection_id: 'connection-1',
              conversation_id: 'C1',
              status: 'sent',
              thread_ts: null,
            }
          : {
              connections: [
                {
                  id: 'connection-1',
                  identity_id: 'identity-1',
                  workspace_id: 'T1',
                  workspace_name: 'Workspace',
                  bot_user_id: 'UBOT',
                  status: 'connected',
                  scopes: [],
                  created_at: '2026-01-01T00:00:00Z',
                },
              ],
            }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const sdk = new Inkbox({ apiKey: 'synthetic-test-key', baseUrl: 'https://sdk.test' })
    await sendSlackReply(sdk, route, 'answer')
    await sendSlackReply(sdk, route, 'answer')
    const sends = requests.filter((request) => request.url.includes('/messages'))
    expect(sends).toHaveLength(2)
    expect(JSON.parse(String(sends[0]?.init?.body))).toEqual({
      conversation_id: 'C1',
      text: 'answer',
      thread_ts: null,
    })
    const key = new Headers(sends[0]?.init?.headers).get('Idempotency-Key')
    expect(key).toMatch(/^deepseek:[0-9a-f]{64}$/)
    expect(new Headers(sends[1]?.init?.headers).get('Idempotency-Key')).toBe(key)
  })

  it('rejects a changed connection workspace before a saved reply is sent', async () => {
    const sendMessage = vi.fn()
    const sdk = {
      slack: {
        listConnections: vi.fn(async () => ({ connections: [{ ...connection, workspaceId: 'TOTHER' }] })),
        sendMessage,
      },
    } as unknown as Inkbox
    await expect(sendSlackReply(sdk, route, 'saved answer')).rejects.toBeInstanceOf(SlackConnectionDenied)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('prepares a fresh workspace, hands off browser installation, then observes the connection', async () => {
    const workspace = { id: 'saved', workspaceId: 'T1', workspaceName: 'Synthetic', status: 'ready' }
    const snapshot = (status: string, connected = false) => ({
      connections: connected ? [connection] : [],
      provisioningWorkspace: workspace,
      setup: { status },
      applicationCreated: true,
    })
    const slack = {
      listConnections: vi
        .fn()
        .mockResolvedValueOnce(snapshot('not_started'))
        .mockResolvedValueOnce(snapshot('pending'))
        .mockResolvedValueOnce(snapshot('ready'))
        .mockResolvedValueOnce(snapshot('ready', true)),
      startSetup: vi.fn(),
      startInstallation: vi.fn(async () => ({
        authorizationUrl: 'https://install.test',
        expiresAt: new Date(10_000),
      })),
    }
    const installation = vi.fn(),
      note = vi.fn()
    let clock = 0
    const sdk = {
      whoami: async () => ({
        authType: 'api_key',
        authSubtype: 'api_key.agent_scoped.claimed',
        scope: 'agent_identity:identity-1',
      }),
      slack,
    } as unknown as Inkbox
    await expect(
      configureSlack(sdk, 'identity-1', false, {
        prompter: { ask: vi.fn(), confirm: async () => true },
        note,
        installation,
        now: () => clock,
        delay: async (milliseconds) => {
          clock += milliseconds
        },
        waitMs: 10_000,
      }),
    ).resolves.toBe(true)
    expect(slack.startSetup).toHaveBeenCalledTimes(1)
    expect(slack.startSetup).toHaveBeenCalledWith('identity-1', 'saved')
    expect(slack.startInstallation).toHaveBeenCalledWith('identity-1', { workspaceId: 'T1' })
    expect(installation).toHaveBeenCalledWith('https://install.test', new Date(10_000))
    expect(note).toHaveBeenCalledWith('Slack workspace connection confirmed.')
  })

  it('does not repeat app creation whose outcome is unknown', async () => {
    const startSetup = vi.fn(),
      installation = vi.fn()
    const sdk = {
      whoami: async () => ({ authType: 'api_key', authSubtype: 'api_key.admin_scoped' }),
      slack: {
        listConnections: async () => ({
          connections: [],
          setup: { status: 'failed', errorCode: 'outcome_unknown' },
        }),
        startSetup,
      },
    } as unknown as Inkbox
    await configureSlack(sdk, 'identity-1', false, {
      prompter: { ask: vi.fn(), confirm: async () => true },
      note: vi.fn(),
      installation,
    })
    expect(startSetup).not.toHaveBeenCalled()
    expect(installation).not.toHaveBeenCalled()
  })
})
