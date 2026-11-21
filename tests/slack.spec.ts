import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { type AgentIdentity, type Inkbox, InkboxAPIError } from '@inkbox/sdk'
import type { TunnelListener } from '@inkbox/sdk/tunnels/connect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { Gateway } from '../src/gateway.js'
import { routeSlack } from '../src/routing.js'
import type { InkboxRuntime } from '../src/runtime.js'
import { parseSlack, SLACK_EVENTS, SlackConnectionDenied } from '../src/slack.js'
import { VoiceNoteNotAdmitted } from '../src/voice-notes.js'

const tunnel = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('@inkbox/sdk/tunnels/connect', () => ({ connect: tunnel.connect }))

const URL = 'https://agent.example.test/webhook'
const FINISHED = 'message.transcription_finished'
const SLACK = [...SLACK_EVENTS]

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
  const identity = { id: 'identity-1', agentHandle: 'deepseek-agent', mailbox: null, phoneNumber: null }
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
  return { gateway, backend, slack, run, stateDir }
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
  vi.useRealTimers()
})

describe('Slack subscription', () => {
  async function startTwice(backend: ReturnType<typeof server>) {
    const first = await harness({ backend })
    await first.gateway.close()
    const held = backend.holders()
    expect(held).toHaveLength(1)
    expect(held[0]?.eventTypes.some((event) => event.startsWith('slack.'))).toBe(true)
    const covered = backend.rows.filter((row) => row.url === URL).flatMap((row) => row.eventTypes)
    expect(covered).toEqual(expect.arrayContaining(SLACK))
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
    expect(slackRows[0]?.eventTypes).toEqual(expect.arrayContaining([...SLACK, FINISHED]))
    expect(slackRows[0]?.eventTypes).not.toContain('slack.session_stopped')
  })

  it('removes a standalone completion row on upgrade and adopts the Slack row', async () => {
    const backend = server([
      { id: 'completions', agentIdentityId: 'identity-1', url: URL, eventTypes: [FINISHED] },
      { id: 'slack', agentIdentityId: 'identity-1', url: URL, eventTypes: SLACK },
    ])
    await startTwice(backend)
    expect(backend.rows.some((row) => row.id === 'completions')).toBe(false)
    expect(backend.holders()[0]?.id).toBe('slack')
    expect(backend.holders()[0]?.eventTypes).toEqual(expect.arrayContaining(SLACK))
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
      expect(slackRows[0]?.eventTypes).toEqual(SLACK)
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
      expect(run).toHaveBeenCalledWith('contact:contact-1', expect.stringContaining('Channel: slack'))
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
