import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { type Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { CompanionInitialization, Inkbox } from '@inkbox/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { COMPANION_MAX_BYTES, companionJob } from '../src/companion.js'
import { resolveConfig } from '../src/config.js'
import { Gateway } from '../src/gateway.js'
import type { InkboxRuntime } from '../src/runtime.js'
import fixture from './fixtures/companion-v1.json' with { type: 'json' }

vi.mock('@inkbox/sdk', () => ({ verifyWebhook: () => true }))
vi.mock('@inkbox/sdk/tunnels/connect', () => ({
  connect: async (_client: unknown, options: { onStatus(s: string): void }) => {
    options.onStatus('connected')
    return {
      publicUrl: 'https://agent.example.test',
      isConnected: true,
      wait: () => new Promise(() => {}),
      aclose: async () => {},
    }
  },
}))

function payload(id = 'trigger', phase = 'initialization', channel = 'phone', scope = 'scope') {
  return {
    id: `event-${id}`,
    event_type:
      channel === 'phone' ? 'text.received' : channel === 'mail' ? 'message.received' : 'imessage.received',
    companion: {
      scope_id: scope,
      conversation_id: 'conversation',
      channel,
      phase,
      sequence: id === 'trigger' ? 1 : 2,
      ...(phase === 'ordinary' ? {} : { activation_id: 'activation' }),
    },
    data: {
      [channel === 'phone' ? 'text_message' : 'message']: {
        id,
        conversation_id: 'conversation',
        thread_id: 'conversation',
        sender_phone_number: '+15555550101',
        sender_number: '+15555550101',
        remote_number: null,
        from_address: 'sponsor@example.test',
        text: id,
        body: id,
      },
      contacts: [{ id: 'sponsor-contact' }],
    },
  }
}

function request(value: unknown) {
  return new Request('https://agent.example.test/webhook', { method: 'POST', body: JSON.stringify(value) })
}

const gateways: Gateway[] = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close()
})

async function harness(stateDir?: string) {
  const config = resolveConfig({ stateDir: stateDir ?? (await mkdtemp(join(tmpdir(), 'companion-'))) })
  const followup = vi.fn()
  const steer = vi.fn()
  const flush = vi.fn(async () => {})
  const agent = {
    whenIdle: vi.fn(async () => {}),
    followup,
    steer,
    session: { seq: 0, events: [] as SessionEvent[] },
  }
  const create = vi.fn(async () => ({ agent, dispose: async () => {} }))
  const ctx = {
    agents: { create, resume: create },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    sessions: { flush },
  } as unknown as Context
  const snapshot: CompanionInitialization = {
    scopeId: 'scope',
    activationId: 'activation',
    conversationId: 'conversation',
    channel: 'phone',
    entries: ['fred', 'nancy', 'trigger'].map((id) => ({
      id,
      author: id,
      occurredAt: '2026-01-01T00:00:00Z',
      text: id,
      historical: id !== 'trigger',
      isTrigger: id === 'trigger',
      attachments: [],
    })),
    replyContext: { channel: 'phone', conversationId: 'conversation' },
    text: 'Fred: /clear\nNancy: YES\nSponsor [trigger]: hello',
    notices: [],
  }
  const loadInitialization = vi.fn(async () => snapshot)
  const activationMessages = vi.fn(async () => ({
    scopeId: 'scope',
    conversationId: 'conversation',
    replyContext: snapshot.replyContext,
  }))
  const client = {
    companion: { loadInitialization, activationMessages },
    webhooks: {
      subscriptions: {
        list: async () => [
          {
            id: 'subscription',
            eventTypes: [
              'message.received',
              'text.received',
              'imessage.received',
              'call.ended',
              'a2a.task.created',
            ],
          },
        ],
        update: async () => {},
      },
    },
  }
  const sendEmail = vi.fn(async () => {})
  const replyAllEmail = vi.fn(async () => {})
  const getMessage = vi.fn(async (id: string) => ({
    id,
    threadId: 'conversation',
    messageId: `<${id}@example.test>`,
    subject: 'Group topic',
    fromAddress: 'sponsor@example.test',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    bodyText: 'Complete stored body' as string | null,
    bodyHtml: null as string | null,
    hasAttachments: true,
    attachmentMetadata: [{ filename: 'group.txt' }],
    replyAllRecipients: { to: ['sponsor@example.test'], cc: ['fred@example.test', 'agent@example.test'] },
  }))
  const identity = {
    id: 'identity',
    agentHandle: 'agent',
    emailAddress: 'agent@example.test',
    sendText: vi.fn(async () => {}),
    sendEmail,
    replyAllEmail,
    getMessage,
  }
  const runtime = {
    getClient: async () => client as unknown as Inkbox,
    getIdentity: async () => identity,
    resolveSigningKey: async () => 'key',
  } as unknown as InkboxRuntime
  const gateway = new Gateway(ctx, runtime, config, { info: () => {}, warn: () => {}, error: () => {} })
  await gateway.start()
  gateways.push(gateway)
  return {
    gateway,
    followup,
    steer,
    create,
    flush,
    snapshot,
    loadInitialization,
    activationMessages,
    agent,
    sendEmail,
    replyAllEmail,
    getMessage,
    stateDir: config.stateDir,
  }
}

it('submits one actual followup, zero steers; durable duplicates and live barrier survive restart', async () => {
  const h = await harness()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  h.loadInitialization.mockImplementation(async () => {
    await blocked
    return h.snapshot
  })
  expect((await h.gateway.handleRequest(request(payload()))).status).toBe(202)
  expect(h.gateway.state.snapshot().companion['event-trigger']?.status).toBe('pending')
  await h.gateway.handleRequest(request(payload('live', 'live')))
  await h.gateway.handleRequest(request(payload()))
  expect(h.followup).toHaveBeenCalledTimes(0)
  release()
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(2))
  expect(h.loadInitialization).toHaveBeenCalledTimes(1)
  expect(h.steer).toHaveBeenCalledTimes(0)
  expect(h.flush).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(h.followup.mock.calls[0])).toContain('Fred: /clear')
  expect(JSON.stringify(h.followup.mock.calls[0])).toContain('Nancy: YES')
  await h.gateway.close()
  const restarted = await harness(h.stateDir)
  await restarted.gateway.handleRequest(request(payload()))
  expect(restarted.followup).toHaveBeenCalledTimes(0)
})

it('recovers pre-submission work but pauses uncertain submissions without followup', async () => {
  const h = await harness()
  const job = companionJob(payload(), 'identity')
  if (!job) throw new Error('Expected Companion job')
  job.status = 'submitting'
  await h.gateway.state.mutate((state) => {
    state.companion[job.event.eventId] = job
  })
  await h.gateway.close()
  const resumed = await harness(h.stateDir)
  expect(resumed.gateway.state.snapshot().companion[job.event.eventId]?.status).toBe('paused')
  expect(resumed.followup).toHaveBeenCalledTimes(0)
  await resumed.gateway.state.mutate((state) => {
    const current = state.companion[job.event.eventId]
    if (current) current.status = 'pending'
  })
  await resumed.gateway.handleRequest(request(payload()))
  await vi.waitFor(() => expect(resumed.followup).toHaveBeenCalledTimes(1))
})

it('fails oversized full input before the host and keeps live events behind failure', async () => {
  const h = await harness()
  h.snapshot.text = 'x'.repeat(COMPANION_MAX_BYTES)
  await h.gateway.handleRequest(request(payload()))
  await h.gateway.handleRequest(request(payload('later', 'live')))
  await vi.waitFor(() => expect(h.gateway.state.snapshot().companion['event-trigger']?.status).toBe('paused'))
  expect(h.followup).toHaveBeenCalledTimes(0)
  expect(h.steer).toHaveBeenCalledTimes(0)
})

it('isolates identity, ordinary phase, activation, and email cohorts regardless of contacts', () => {
  const ordinary = companionJob(payload('one', 'ordinary'), 'identity')
  const active = companionJob(payload(), 'identity')
  const other = companionJob(payload('one', 'initialization', 'mail', 'other-scope'), 'identity')
  const owner = companionJob(payload(), 'another-identity')
  if (!ordinary || !active || !other || !owner) throw new Error('Expected Companion jobs')
  expect(new Set([ordinary, active, other, owner].map((job) => job.event.routeKey)).size).toBe(4)
  expect(active.event.target).toEqual({ channel: 'sms', conversationId: 'conversation' })
  expect(companionJob(payload('trigger', 'initialization', 'imessage'), 'identity')?.event.target).toEqual({
    channel: 'imessage',
    conversationId: 'conversation',
  })
})

it('hydrates on live-first receipt then submits that live input separately', async () => {
  const h = await harness()
  await h.gateway.handleRequest(request(payload('later', 'live')))
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(2))
  await h.gateway.handleRequest(request(payload()))
  await vi.waitFor(() => expect(h.gateway.state.snapshot().companion['event-trigger']?.status).toBe('done'))
  expect(h.followup).toHaveBeenCalledTimes(2)
  expect(h.loadInitialization).toHaveBeenCalledTimes(1)
})

it('persists the mail cohort and replies through the stored parent, not the last sender', async () => {
  const h = await harness()
  h.snapshot.channel = 'mail'
  h.snapshot.replyContext = {
    channel: 'mail',
    conversationId: 'conversation',
    to: ['sponsor@example.test'],
    cc: ['fred@example.test'],
    replyToMessageId: 'parent',
  } as typeof h.snapshot.replyContext
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  h.flush.mockImplementation(async () => {
    await wait
  })
  h.followup.mockImplementation(() => {
    h.agent.session.events.push({
      seq: 0,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'Group reply' }] } },
    } as SessionEvent)
  })
  await h.gateway.handleRequest(request(payload('trigger', 'initialization', 'mail')))
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1))
  await h.gateway.handleRequest(request(payload('later', 'live', 'mail')))
  release()
  await vi.waitFor(() =>
    expect(h.sendEmail).toHaveBeenCalledWith({
      to: ['sponsor@example.test'],
      cc: ['fred@example.test'],
      bodyText: 'Group reply',
      subject: 'Re: Group topic',
      inReplyToMessageId: '<parent@example.test>',
    }),
  )
  expect(h.replyAllEmail).toHaveBeenCalledTimes(0)
  expect(h.steer).toHaveBeenCalledTimes(0)
})

it('ordinary tracked traffic never hydrates an activation', async () => {
  const h = await harness()
  await h.gateway.handleRequest(request(payload('ordinary', 'ordinary')))
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1))
  expect(h.loadInitialization).toHaveBeenCalledTimes(0)
  expect(h.activationMessages).toHaveBeenCalledTimes(0)
})

it('hydrates ordinary mail and replies to its canonical group audience without an activation fetch', async () => {
  const h = await harness()
  h.followup.mockImplementation(() => {
    h.agent.session.events.push({
      seq: 0,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'Ordinary group reply' }] } },
    } as SessionEvent)
  })
  const event = payload('ordinary-mail', 'ordinary', 'mail')
  Object.assign(event.data.message ?? {}, {
    body: 'short preview',
    body_state: 'truncated',
    body_truncated: true,
  })
  await h.gateway.handleRequest(request(event))
  await vi.waitFor(() => expect(h.sendEmail).toHaveBeenCalledTimes(1))
  expect(h.sendEmail).toHaveBeenCalledWith({
    to: ['sponsor@example.test'],
    cc: ['fred@example.test'],
    subject: 'Re: Group topic',
    bodyText: 'Ordinary group reply',
    inReplyToMessageId: '<ordinary-mail@example.test>',
  })
  const input = h.followup.mock.calls[0]?.[0].content[0].text as string
  expect(input).toContain('Complete stored body')
  expect(input).toContain('group.txt')
  expect(input).not.toContain('short preview')
  expect(h.loadInitialization).toHaveBeenCalledTimes(0)
  expect(h.activationMessages).toHaveBeenCalledTimes(0)
  expect(h.gateway.state.snapshot().companion['event-ordinary-mail']?.submission?.target).toMatchObject({
    channel: 'companion-email',
    to: ['sponsor@example.test'],
    cc: ['fred@example.test'],
    replyToMessageId: 'ordinary-mail',
  })
})

it('hydrates live mail instead of submitting an unavailable webhook body', async () => {
  const h = await harness()
  h.snapshot.channel = 'mail'
  h.snapshot.replyContext = {
    channel: 'mail',
    conversationId: 'conversation',
    replyToMessageId: 'parent',
    to: ['sponsor@example.test'],
    cc: ['fred@example.test'],
  }
  await h.gateway.handleRequest(request(payload('trigger', 'initialization', 'mail')))
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1))
  const event = payload('live-mail', 'live', 'mail')
  Object.assign(event.data.message ?? {}, { body: null, body_state: 'unavailable', body_truncated: true })
  await h.gateway.handleRequest(request(event))
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(2))
  expect(h.getMessage).toHaveBeenCalledWith('live-mail')
  expect(h.followup.mock.calls[1]?.[0].content[0].text).toContain('Complete stored body')
  expect(h.loadInitialization).toHaveBeenCalledTimes(1)
})

it.each(['sender', 'thread', 'body'] as const)(
  'withholds incomplete or mismatched stored mail: %s',
  async (fault) => {
    const h = await harness()
    const stored = await h.getMessage('ordinary-mail')
    if (fault === 'sender') stored.fromAddress = 'other@example.test'
    if (fault === 'thread') stored.threadId = 'another-thread'
    if (fault === 'body') {
      stored.bodyText = null
      stored.bodyHtml = null
      stored.attachmentMetadata = []
      stored.hasAttachments = false
    }
    h.getMessage.mockResolvedValueOnce(stored)
    await h.gateway.handleRequest(request(payload('ordinary-mail', 'ordinary', 'mail')))
    await vi.waitFor(() =>
      expect(h.gateway.state.snapshot().companion['event-ordinary-mail']?.status).toBe('paused'),
    )
    expect(h.followup).toHaveBeenCalledTimes(0)
  },
)

it('rejects an out-of-cohort resolved Reply-To before sending', async () => {
  const h = await harness()
  h.snapshot.channel = 'mail'
  h.snapshot.replyContext = {
    channel: 'mail',
    conversationId: 'conversation',
    replyToMessageId: 'parent',
    to: ['sponsor@example.test'],
    cc: ['fred@example.test'],
  }
  const parent = await h.getMessage('parent')
  parent.replyAllRecipients.to = ['outside@example.test']
  h.getMessage.mockResolvedValue(parent)
  h.followup.mockImplementation(() => {
    h.agent.session.events.push({
      seq: 0,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'Group response' }] } },
    } as SessionEvent)
  })
  await h.gateway.handleRequest(request(payload('trigger', 'initialization', 'mail')))
  await vi.waitFor(() =>
    expect(h.gateway.state.snapshot().deliveries['event-trigger:initialization']?.attempts).toBe(1),
  )
  expect(h.sendEmail).toHaveBeenCalledTimes(0)
})

it.each(['mail', 'phone', 'imessage'])('rejects a missing actual author for %s', async (channel) => {
  const h = await harness()
  const event = payload('trigger', 'initialization', channel)
  const message = channel === 'phone' ? event.data.text_message : event.data.message
  if (!message) throw new Error('Missing message')
  for (const key of [
    'from_address',
    'sender_phone_number',
    'remote_phone_number',
    'sender_number',
    'remote_number',
  ])
    Reflect.deleteProperty(message, key)
  expect((await h.gateway.handleRequest(request(event))).status).toBe(422)
  expect(h.followup).toHaveBeenCalledTimes(0)
  expect(h.loadInitialization).toHaveBeenCalledTimes(0)
})

it('does not acknowledge durable acceptance failures', async () => {
  const h = await harness()
  const mutate = vi.spyOn(h.gateway.state, 'mutate').mockRejectedValueOnce(new Error('disk unavailable'))
  expect((await h.gateway.handleRequest(request(payload()))).status).toBe(503)
  expect(h.followup).toHaveBeenCalledTimes(0)
  mutate.mockRestore()
})

it('pauses a failed activation read without sending trigger-only content', async () => {
  const h = await harness()
  h.loadInitialization.mockRejectedValueOnce(new Error('Companion activation unavailable'))
  await h.gateway.handleRequest(request(payload()))
  await vi.waitFor(() => expect(h.gateway.state.snapshot().companion['event-trigger']?.status).toBe('paused'))
  expect(h.followup).toHaveBeenCalledTimes(0)
})

it('pauses after followup if host persistence fails and never resubmits on restart', async () => {
  const h = await harness()
  h.flush.mockRejectedValueOnce(new Error('Host persistence interrupted'))
  await h.gateway.handleRequest(request(payload()))
  await vi.waitFor(() => expect(h.gateway.state.snapshot().companion['event-trigger']?.status).toBe('paused'))
  expect(h.followup).toHaveBeenCalledTimes(1)
  await h.gateway.close()
  const restarted = await harness(h.stateDir)
  await restarted.gateway.handleRequest(request(payload()))
  expect(restarted.followup).toHaveBeenCalledTimes(0)
})

it('recovers an accepted pending hydration job at startup without another callback', async () => {
  const h = await harness()
  const job = companionJob(payload(), 'identity')
  if (!job) throw new Error('Expected job')
  await h.gateway.state.mutate((state) => {
    state.companion[job.event.eventId] = job
  })
  await h.gateway.close()
  const restarted = await harness(h.stateDir)
  await vi.waitFor(() => expect(restarted.followup).toHaveBeenCalledTimes(1))
  expect(restarted.loadInitialization).toHaveBeenCalledTimes(1)
})

it('does not accept group history or bystanders as host approval answers', async () => {
  const h = await harness()
  await h.gateway.handleRequest(request(payload()))
  await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1))
  expect(await h.gateway.askApproval(h.agent as unknown as Agent, 'Run tool?')).toBe('rejected')
  expect(h.sendEmail).toHaveBeenCalledTimes(0)
})

it('revalidates after delayed host creation and withholds a revoked initialization', async () => {
  const h = await harness()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  h.create.mockImplementation(async () => {
    await waiting
    return { agent: h.agent, dispose: async () => {} }
  })
  await h.gateway.handleRequest(request(payload()))
  await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1))
  h.activationMessages.mockRejectedValueOnce(new Error('Activation revoked'))
  release()
  await vi.waitFor(() => expect(h.gateway.state.snapshot().companion['event-trigger']?.status).toBe('paused'))
  expect(h.followup).toHaveBeenCalledTimes(0)
})

it.each(['mail', 'phone', 'imessage'] as const)(
  'isolates ordinary and activation host sessions for %s',
  async (channel) => {
    const h = await harness()
    h.snapshot.channel = channel
    h.snapshot.replyContext = {
      channel,
      conversationId: 'conversation',
      ...(channel === 'mail'
        ? { replyToMessageId: 'parent', to: ['sponsor@example.test'], cc: ['fred@example.test'] }
        : {}),
    }
    await h.gateway.handleRequest(request(payload('ordinary', 'ordinary', channel)))
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1))
    await h.gateway.handleRequest(request(payload('trigger', 'initialization', channel)))
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(2))
    expect(h.loadInitialization).toHaveBeenCalledTimes(1)
    expect(Object.keys(h.gateway.state.snapshot().routes)).toHaveLength(2)
    expect(
      new Set(Object.values(h.gateway.state.snapshot().routes).map((route) => route.sessionId)).size,
    ).toBe(2)
    expect(h.steer).toHaveBeenCalledTimes(0)
  },
)

it('rejects a second gateway owner for the same durable state', async () => {
  const h = await harness()
  await expect(harness(h.stateDir)).rejects.toThrow('Lock file is already being held')
})

it('preserves one native host inbox input across an uncertain persisted submission', async () => {
  const h = await harness()
  const session = Session.create(SessionId('companion-host-session'))
  const notifications = { inserted: () => {}, discarded: () => {}, claimed: () => {} }
  const inbox = new Inbox(session, notifications)
  Reflect.set(h.agent, 'session', session)
  h.followup.mockImplementation((message) => inbox.append('next-turn', message))
  const logPath = join(h.stateDir, 'host-session.json')
  h.flush.mockImplementation(async () => {
    await writeFile(logPath, JSON.stringify({ header: session.header, events: session.events }))
    throw new Error('Acknowledgement lost after host persistence')
  })
  await h.gateway.handleRequest(request(payload()))
  await vi.waitFor(() => expect(h.gateway.state.snapshot().companion['event-trigger']?.status).toBe('paused'))
  expect(h.followup).toHaveBeenCalledTimes(1)
  expect(inbox.nextTurn).toHaveLength(1)
  const persisted = JSON.parse(await readFile(logPath, 'utf8'))
  const restored = Session.fromRestore(session.id, persisted.events, persisted.header)
  expect(new Inbox(restored, notifications).nextTurn).toHaveLength(1)
  await h.gateway.close()
  const restarted = await harness(h.stateDir)
  expect(restarted.followup).toHaveBeenCalledTimes(0)
  expect(restarted.create).toHaveBeenCalledTimes(0)
})

it.each(['mail', 'phone', 'imessage'] as const)(
  'uses packaged SDK pages for one %s host followup',
  async (channel) => {
    const { CompanionResource } = await vi.importActual<typeof import('@inkbox/sdk')>('@inkbox/sdk')
    const pages = fixture.pages.map((page) => ({
      ...page,
      channel,
      reply_context: { ...page.reply_context, channel },
    }))
    const first = pages[0]
    if (!first) throw new Error('Missing fixture page')
    const { scope_id: scope, activation_id: activation, conversation_id: conversation } = first
    const trigger = first.reply_context.reply_to_message_id
    const get = vi.fn(async (_path: string, options: { cursor?: string }) => pages[options.cursor ? 1 : 0])
    const companion = new CompanionResource({ get } as unknown as ConstructorParameters<
      typeof CompanionResource
    >[0])
    const h = await harness()
    h.loadInitialization.mockImplementation(() =>
      companion.loadInitialization('agent', activation, { maxBytes: COMPANION_MAX_BYTES }),
    )
    h.activationMessages.mockImplementation(() => companion.activationMessages('agent', activation))
    const event = payload(trigger, 'initialization', channel)
    event.companion.scope_id = scope
    event.companion.activation_id = activation
    event.companion.conversation_id = conversation
    const message = channel === 'phone' ? event.data.text_message : event.data.message
    if (!message || Array.isArray(message)) throw new Error('Missing test message')
    message.conversation_id = conversation
    message.thread_id = conversation
    await h.gateway.handleRequest(request(event))
    await vi.waitFor(() => expect(h.followup).toHaveBeenCalledTimes(1))
    expect(get).toHaveBeenCalledTimes(4)
    const input = h.followup.mock.calls[0]?.[0].content[0].text as string
    expect(input.match(/"author":"fred@example.com"/g)).toHaveLength(1)
    expect(input.match(/"author":"nancy@example.com"/g)).toHaveLength(1)
    expect(input.match(/"author":"sponsor@example.com"/g)).toHaveLength(1)
    expect(input).toContain('future_history_notice')
    expect(input).toContain('text/plain')
    expect(h.steer).toHaveBeenCalledTimes(0)
  },
)
