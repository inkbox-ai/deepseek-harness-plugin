import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { type AgentIdentity, type Inkbox, InkboxAPIError } from '@inkbox/sdk'
import {
  type ConnectOptions,
  connect,
  type InkboxWebSocket,
  type TunnelListener,
} from '@inkbox/sdk/tunnels/connect'
import { AgentManager } from './agent-manager.js'
import { renderChannelEvent, resolveChannelInstruction } from './channel-instructions.js'
import type { ResolvedConfig } from './config.js'
import { toIMessagePlainText } from './imessage.js'
import {
  INBOUND_FILES_SWEEP_MS,
  INBOUND_MAX_CONCURRENT_SCRIPTS,
  INBOUND_MAX_PENDING_BYTES,
  INBOUND_MAX_PENDING_EVENTS,
  INBOUND_RELOAD_DELAY_MS,
  INBOUND_REPORT_ERROR_MAX_CHARS,
  INBOUND_RETRY_DELAYS_MS,
  INBOUND_TURN_TIMEOUT_MS,
  type InboundEvent,
  InboundStore,
  inboundBodyBytes,
  inboundRoutedEvent,
  inboundSize,
  type PendingInbound,
  parseInbound,
  runInboundScript,
  scriptInput,
  sweepInboundFiles,
  writeInboundFiles,
} from './inbound.js'
import {
  authenticateCallWebSocket,
  awaitRealtimeReady,
  connectOpenAIRealtime,
  loadCallMeta,
  runRealtimeBridge,
  type TranscriptTurn,
} from './realtime.js'
import { type ReplyTarget, type RoutedEvent, routeForAddress, routeSlack, routeWebhook } from './routing.js'
import type { InkboxRuntime } from './runtime.js'
import {
  isSlackEvent,
  ownSlackConnection,
  parseSlack,
  prepareSlackReply,
  reconcileSlackSubscription,
  retryableRead,
  SlackConnectionDenied,
  sendSlackReply,
  slackControlText,
} from './slack.js'
import { StateStore } from './state.js'
import { replyState } from './terminal-reply.js'
import {
  pollVoiceNote,
  TRANSCRIPTION_FINISHED,
  transcriptionEventUnsupported,
  VoiceNoteInbox,
  VoiceNoteNotAdmitted,
} from './voice-notes.js'
import { authenticateWebhook } from './webhook-providers.js'

interface Queue {
  buffered: RoutedEvent[]
  timer: ReturnType<typeof setTimeout> | undefined
  active:
    | { events: RoutedEvent[]; target: ReplyTarget; phase: 'generating' | 'finishing'; stopped?: boolean }
    | undefined
}

/** The participant who may answer a pending prompt on its route. */
interface ReplyAuthor {
  channel: RoutedEvent['channel']
  sender: string
}

interface PendingHuman {
  kind: 'approval' | 'question'
  author?: ReplyAuthor
  resolve(value: string): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface TypingPulse {
  deadline: number
  timer?: ReturnType<typeof setTimeout>
}

export const IMESSAGE_TYPING_REFRESH_MS = 40_000
export const IMESSAGE_TYPING_MAX_MS = 600_000

const EVENT_TYPES = {
  email: ['message.received', 'message.sent', 'message.delivered', 'message.bounced', 'message.failed'],
  sms: ['text.received', 'text.sent', 'text.delivered', 'text.delivery_failed', 'text.delivery_unconfirmed'],
  imessage: [
    'imessage.received',
    'imessage.reaction_received',
    'imessage.sent',
    'imessage.delivered',
    'imessage.delivery_failed',
  ],
  whatsapp: ['whatsapp.received'],
  call: ['call.ended'],
  a2a: ['a2a.task.created', 'a2a.task.message', 'a2a.task.canceled', 'a2a.sent_task.updated'],
} as const

export type SlackStatus = 'disabled' | 'connected' | 'not connected' | 'unverified'

export interface GatewayStatus {
  ready: boolean
  publicUrl?: string
  connected: boolean
  identity: string
  slack: SlackStatus
  startedAt: string
  pid: number
  updatedAt: string
}

export class Gateway {
  readonly state: StateStore
  readonly agents: AgentManager
  private listener: TunnelListener | undefined
  private tunnelTask: Promise<void> | undefined
  private identity: AgentIdentity | undefined
  private client: Inkbox | undefined
  private signingKey: string | undefined
  private githubWebhookSecret: string | undefined
  private closing = false
  private voiceNotes: VoiceNoteInbox | undefined
  private slackConnection: Exclude<SlackStatus, 'disabled'> = 'unverified'
  private readonly queues = new Map<string, Queue>()
  private readonly latestTargets = new Map<string, ReplyTarget>()
  private readonly latestAuthors = new Map<string, ReplyAuthor | undefined>()
  private readonly pendingHuman = new Map<string, PendingHuman>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly activeDeliveries = new Set<string>()
  private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly typingPulses = new Map<string, TypingPulse>()
  private readonly inboundStore: InboundStore
  private readonly inboundFiles: string
  private readonly inbound = new Map<string, PendingInbound>()
  private readonly inboundTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inboundLanes = new Map<string, Promise<void>>()
  private readonly inboundPersisting = new Map<string, Promise<void>>()
  private readonly inboundTurns = new Set<AbortController>()
  private readonly scriptWaiters: (() => void)[] = []
  private scriptsRunning = 0
  private inboundReload: ReturnType<typeof setTimeout> | undefined
  private inboundSweep: ReturnType<typeof setInterval> | undefined
  // Local delivery: the host hands verified requests to handleRequest; no tunnel or public URL.
  private readonly localDelivery = process.env.INKBOX_DELIVERY_MODE?.trim().toLowerCase() === 'local'
  private readonly startedAt = new Date().toISOString()
  /** Set by a host that acknowledges deliveries itself after `inboundAdmits`; an acknowledged one is never refused. */
  externalAdmission = false

  constructor(
    private readonly ctx: Context,
    private readonly runtime: InkboxRuntime,
    private readonly config: ResolvedConfig,
    private readonly log: Pick<Console, 'info' | 'warn' | 'error'> = console,
  ) {
    this.state = new StateStore(join(config.stateDir, 'gateway-state.json'))
    this.inboundStore = new InboundStore(join(config.stateDir, 'inbound'))
    // In the home directory so a sandboxed agent can read it even when the state directory is elsewhere.
    this.inboundFiles = join(homedir(), '.inkbox', 'inbound', 'events')
    this.agents = new AgentManager(ctx, config, this.state)
  }

  async initialize(): Promise<void> {
    await this.state.initialize()
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
    await this.loadInbound(false)
    await sweepInboundFiles(this.inboundFiles)
    this.inboundSweep ??= setInterval(() => void sweepInboundFiles(this.inboundFiles), INBOUND_FILES_SWEEP_MS)
    this.inboundSweep.unref?.()
    this.client = await this.runtime.getClient()
    this.identity = await this.runtime.getIdentity()
    this.signingKey = await this.runtime.resolveSigningKey()
    if (this.config.externalEvents) {
      this.githubWebhookSecret = (
        await this.ctx.credentials.resolve(credentialRef(this.config.githubWebhookSecretRef))
      )?.value
    }
  }

  async start(): Promise<void> {
    await this.initialize()
    if (!this.client || !this.identity) throw new Error('Gateway identity is unavailable')
    if (this.localDelivery) {
      if (this.signingKey === undefined) throw new Error('Webhook signing key is unavailable')
      this.resumeDeliveries()
      this.voiceNoteInbox().recover()
      await this.checkSlack()
      await this.writeStatus(true)
      return
    }
    let connectedResolve: (() => void) | undefined
    const connected = new Promise<void>((resolve) => {
      connectedResolve = resolve
    })
    const tunnelStateDir = join(this.config.stateDir, 'tunnel')
    const connectOptions: ConnectOptions = {
      name: this.identity.agentHandle,
      stateDir: tunnelStateDir,
      installSignalHandlers: false,
      handler: (request) => this.handleRequest(request),
      wsHandler: (ws) => this.handleWebSocket(ws),
      onStatus: (status) => {
        this.log.info(`[inkbox] tunnel ${status}`)
        if (status === 'connected') connectedResolve?.()
      },
    }
    try {
      this.listener = await connect(this.client, connectOptions)
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TunnelRemoved') throw error
      this.log.warn('[inkbox] cached tunnel was removed; rebuilding local tunnel state')
      await rm(tunnelStateDir, { recursive: true, force: true })
      this.listener = await connect(this.client, connectOptions)
    }
    this.tunnelTask = this.listener.wait()
    await Promise.race([
      connected,
      this.tunnelTask.then(() => {
        throw new Error('Inkbox tunnel closed before becoming ready')
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out connecting the Inkbox tunnel')), 30_000),
      ),
    ])
    await this.reconcileSubscriptions(this.listener.publicUrl)
    this.signingKey = await this.runtime.resolveSigningKey()
    if (this.signingKey === undefined) {
      throw new Error(
        'A webhook signing key already exists but is not available to this profile. Run setup to configure it; it will not be rotated automatically.',
      )
    }
    this.resumeDeliveries()
    this.voiceNoteInbox().recover()
    await this.checkSlack()
    await this.writeStatus(true)
    void this.tunnelTask.catch((error) => {
      if (!this.closing) this.log.error('[inkbox] tunnel stopped unexpectedly', error)
    })
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(this.status(), {
        status: this.localDelivery || this.listener?.isConnected ? 200 : 503,
      })
    }
    if (request.method !== 'POST' || url.pathname !== '/webhook')
      return new Response('Not found', { status: 404 })
    const body = await request.arrayBuffer()
    if (body.byteLength > 2 * 1024 * 1024) return new Response('Payload too large', { status: 413 })
    const payload = Buffer.from(body)
    const authenticated = authenticateWebhook(payload, request.headers, request.url, {
      ...(this.signingKey ? { inkbox: this.signingKey } : {}),
      ...(this.githubWebhookSecret ? { github: this.githubWebhookSecret } : {}),
      externalEvents: this.config.externalEvents,
    })
    if (authenticated.outcome === 'invalid') return new Response(authenticated.detail, { status: 401 })
    if (authenticated.outcome === 'unavailable') return new Response(authenticated.detail, { status: 503 })
    if (authenticated.outcome === 'ignored') return new Response(authenticated.detail, { status: 202 })
    // Refused before any host admission: retrying a malformed event cannot succeed.
    if (
      authenticated.source === 'inkbox' &&
      this.localDelivery &&
      authenticated.payload.event_type === 'inbound.received' &&
      parseInbound(authenticated.payload) === undefined
    )
      return new Response('Invalid inbound event', { status: 400 })
    return this.dispatchVerified(authenticated.payload, authenticated.source)
  }

  async dispatchVerified(
    payload: Record<string, unknown>,
    source: 'inkbox' | 'github',
    resolvedVoiceNote = false,
  ): Promise<Response> {
    if (this.closing) {
      if (resolvedVoiceNote) throw new VoiceNoteNotAdmitted('Gateway is stopping')
      return new Response('Gateway is stopping', { status: 503 })
    }
    if (payload.event_type === 'inbound.received')
      return source === 'inkbox' && this.localDelivery
        ? this.acceptInbound(payload)
        : new Response('Ignored', { status: 202 })
    // Disabled Slack is acknowledged without waiting on a transcript.
    const slack = isSlackEvent(payload.event_type)
    if (slack && (source !== 'inkbox' || !this.config.slackEnabled))
      return new Response('Ignored', { status: 202 })
    if (source === 'inkbox' && !resolvedVoiceNote && (await this.voiceNoteInbox().accept(payload)))
      return new Response('Accepted', { status: 202 })
    const callId = endedCallId(payload)
    if (callId && !(await this.claimCallReconciliation(callId)))
      return new Response('Duplicate', { status: 200 })
    // Slack reads happen before admission; a temporary failure leaves the message unadmitted.
    const slackRouted = slack ? await this.routeSlackEvent(payload) : undefined
    if (slackRouted === 'stopped') return new Response('Accepted', { status: 202 })
    if (slack && slackRouted === undefined) return new Response('Ignored', { status: 202 })
    let routed: RoutedEvent | undefined
    try {
      routed =
        slackRouted ??
        routeWebhook(
          payload,
          this.state.snapshot().routingKey,
          source !== 'inkbox' || this.config.externalEvents,
        )
      if (routed === undefined) return new Response('Ignored', { status: 202 })
      const { eventId } = routed
      // One Slack message can arrive under several envelopes; its retained message ID identifies it.
      const marker = routed.channel === 'slack' ? `slack-message:${routed.messageId ?? eventId}` : undefined
      const accepted = await this.state.mutate((state) => {
        if (state.seen[eventId] !== undefined) return false
        if (marker !== undefined && state.seen[marker] !== undefined) {
          state.replied[eventId] ??= Date.now()
          return false
        }
        const now = Date.now()
        state.seen[eventId] = now
        if (marker !== undefined) state.seen[marker] = now
        return true
      })
      if (!accepted) return new Response('Duplicate', { status: 200 })
    } catch (error) {
      // A lock can fail to release after the reservation committed. Never
      // replay a reserved event or an exception from the host handoff below.
      if (resolvedVoiceNote && (!routed || this.state.snapshot().seen[routed.eventId] === undefined))
        throw new VoiceNoteNotAdmitted('Voice note could not be reserved', { cause: error })
      throw error
    }
    await this.accept(routed)
    return new Response('Accepted', { status: 202 })
  }

  /**
   * A verified Slack message from a connection this identity owns, or undefined
   * when it is not for the agent. A native stop is applied here.
   */
  private async routeSlackEvent(
    payload: Record<string, unknown>,
  ): Promise<RoutedEvent | 'stopped' | undefined> {
    const identity = this.identity,
      client = this.client
    if (identity === undefined || client === undefined) throw new Error('Gateway identity is unavailable')
    const route = parseSlack(payload, identity.id)
    if (route === undefined) return undefined
    const connection = await readBeforeAdmission(() =>
      ownSlackConnection(client, identity.id, route.connectionId),
    )
    if (connection.generation !== undefined) route.connectionGeneration = connection.generation
    if (connection.workspaceId !== route.workspaceId) throw new Error('Slack connection workspace mismatch.')
    const routed = routeSlack(
      payload,
      route,
      slackControlText(route, connection.botUserId),
      this.state.snapshot().routingKey,
    )
    if (route.nativeStop) {
      this.stopSlack(routed)
      return 'stopped'
    }
    // Quiet channel traffic cannot start a session; an engaged thread continues.
    // An admitted turn counts even before its session is created.
    const engaged =
      this.state.snapshot().routes[routed.routeKey] !== undefined || this.queues.has(routed.routeKey)
    return route.addressed || engaged ? routed : undefined
  }

  /**
   * Stop work the same Slack actor started in this thread: its pending prompt,
   * its queued messages and its running turn. A reply already being delivered
   * is not retracted.
   */
  private stopSlack(stop: RoutedEvent): void {
    const author = stop.sender
    const pending = this.pendingHuman.get(stop.routeKey)
    if (pending?.author?.channel === 'slack' && pending.author.sender === author) {
      this.pendingHuman.delete(stop.routeKey)
      clearTimeout(pending.timer)
      pending.reject(new Error('Stopped from Slack'))
    }
    const queue = this.queues.get(stop.routeKey)
    if (queue === undefined) return
    const dropped = queue.buffered.filter((event) => event.channel === 'slack' && event.sender === author)
    if (dropped.length) {
      queue.buffered = queue.buffered.filter((event) => !dropped.includes(event))
      if (!queue.buffered.length && queue.timer !== undefined) {
        clearTimeout(queue.timer)
        queue.timer = undefined
      }
      this.track(
        this.state
          .mutate((state) => {
            for (const event of dropped) state.replied[event.eventId] = Date.now()
          })
          .catch((error) => this.log.error('[inkbox] Slack stop could not be recorded', error)),
      )
    }
    const active = queue.active
    const source = active?.events.at(-1)
    if (active?.phase === 'generating' && source?.channel === 'slack' && source.sender === author) {
      active.stopped = true
      this.agents.cancel(stop.routeKey, 'Stopped from Slack')
    }
  }

  private async checkSlack(): Promise<void> {
    const identity = this.identity
    if (!this.config.slackEnabled || this.client === undefined || identity === undefined) return
    try {
      const { connections } = await this.client.slack.listConnections(identity.id)
      this.slackConnection = connections.some(
        (connection) => connection.identityId === identity.id && connection.status === 'connected',
      )
        ? 'connected'
        : 'not connected'
    } catch {
      this.slackConnection = 'unverified'
    }
  }

  private async acceptInbound(payload: Record<string, unknown>): Promise<Response> {
    const event = parseInbound(payload)
    if (event === undefined) return new Response('Invalid inbound event', { status: 400 })
    // The host tracks the envelope id; deduplication uses the delivery id.
    const trackingId = typeof payload.id === 'string' && payload.id ? payload.id : event.deliveryId
    const marker = `inbound-delivery:${event.deliveryId}`
    // A duplicate is acknowledged only once the first copy is durably stored.
    const persisting = this.inboundPersisting.get(event.deliveryId)
    if (persisting) await persisting.catch(() => {})
    if (this.inbound.has(event.deliveryId) || this.state.snapshot().seen[marker] !== undefined) {
      await this.state.mutate((state) => {
        state.replied[trackingId] ??= Date.now()
      })
      return new Response('Duplicate', { status: 200 })
    }
    if (!this.externalAdmission && !this.inboundHasRoom(event))
      return new Response('Inbound queue is full', { status: 503 })
    const item: PendingInbound = { trackingId, event, attempts: 0, dueAt: Date.now() }
    const stored = this.persistInbound(item, marker).finally(() =>
      this.inboundPersisting.delete(event.deliveryId),
    )
    this.inboundPersisting.set(event.deliveryId, stored)
    await stored
    return new Response('Accepted', { status: 202 })
  }

  private async persistInbound(item: PendingInbound, marker: string): Promise<void> {
    await this.inboundStore.save(item)
    this.inbound.set(item.event.deliveryId, item)
    this.scheduleInbound(item)
    // Persisted work completes the managed delivery; handling continues from the local queue.
    await this.state.mutate((state) => {
      const now = Date.now()
      state.seen[marker] = now
      state.replied[item.trackingId] = now
    })
  }

  /** False when a new `inbound.received` delivery should be refused before it is acknowledged. */
  inboundAdmits(payload: Record<string, unknown>): boolean {
    const event = parseInbound(payload)
    if (
      event === undefined ||
      this.inbound.has(event.deliveryId) ||
      this.inboundPersisting.has(event.deliveryId)
    )
      return true
    return this.inboundHasRoom(event)
  }

  private inboundHasRoom(event: InboundEvent): boolean {
    let bytes = Buffer.byteLength(event.body)
    for (const item of this.inbound.values()) bytes += inboundSize(item)
    return (
      this.inbound.size + this.inboundPersisting.size < INBOUND_MAX_PENDING_EVENTS &&
      bytes <= INBOUND_MAX_PENDING_BYTES
    )
  }

  // Files a read error skipped stay on disk and are retried until they load.
  private async loadInbound(schedule: boolean): Promise<void> {
    this.inboundReload = undefined
    if (this.closing) return
    // A job that finishes during the load may still be read from its old file.
    const known = new Set(this.inbound.keys())
    const { items, unreadable } = await this.inboundStore.load()
    for (const item of items) {
      if (known.has(item.event.deliveryId) || this.inbound.has(item.event.deliveryId)) continue
      this.inbound.set(item.event.deliveryId, item)
      if (schedule) this.scheduleInbound(item)
    }
    if (unreadable && !this.closing) {
      this.log.warn('[inkbox] some queued inbound events could not be read; retrying')
      this.inboundReload = setTimeout(() => {
        void this.loadInbound(true).catch((error) =>
          this.log.error('[inkbox] inbound queue reload failed', error),
        )
      }, INBOUND_RELOAD_DELAY_MS)
      this.inboundReload.unref?.()
    }
  }

  private async acquireScriptSlot(): Promise<void> {
    if (this.scriptsRunning < INBOUND_MAX_CONCURRENT_SCRIPTS) {
      this.scriptsRunning++
      return
    }
    await new Promise<void>((resolve) => this.scriptWaiters.push(resolve))
  }

  private releaseScriptSlot(): void {
    const next = this.scriptWaiters.shift()
    if (next) next()
    else this.scriptsRunning--
  }

  private scheduleInbound(item: PendingInbound): void {
    const key = item.event.deliveryId
    if (this.closing || this.inboundTimers.has(key)) return
    const dueAt = item.report?.dueAt ?? item.dueAt
    const timer = setTimeout(
      () => {
        this.inboundTimers.delete(key)
        // Handler work runs one event at a time per source; reports run independently.
        const lane = item.report ? `report:${key}` : `source:${item.event.sourceId}`
        const run = (this.inboundLanes.get(lane) ?? Promise.resolve()).then(() => this.stepInbound(key))
        this.inboundLanes.set(lane, run)
        void run.finally(() => {
          if (this.inboundLanes.get(lane) === run) this.inboundLanes.delete(lane)
        })
        this.track(run)
      },
      Math.max(0, dueAt - Date.now()),
    )
    this.inboundTimers.set(key, timer)
  }

  private async stepInbound(key: string): Promise<void> {
    const item = this.inbound.get(key)
    if (item === undefined || this.closing) return
    try {
      if (item.report) return await this.sendInboundReport(item)
      const { event } = item
      if (item.turnStarted) return await this.reportInbound(item, 'Agent turn was interrupted by a restart')
      if (event.handler.type === 'script' && item.output === undefined) {
        if (item.attempts > INBOUND_RETRY_DELAYS_MS.length)
          return await this.reportInbound(item, 'Script run was interrupted by a restart')
        await this.acquireScriptSlot()
        let result: Awaited<ReturnType<typeof runInboundScript>>
        const script = new AbortController()
        this.inboundTurns.add(script)
        try {
          if (this.closing) return
          // Counted before running so a crash mid-run still uses up the attempt.
          item.attempts += 1
          await this.inboundStore.save(item)
          result = await runInboundScript(
            event.handler.command,
            homedir(),
            scriptInput(event),
            undefined,
            script.signal,
          )
        } finally {
          this.inboundTurns.delete(script)
          this.releaseScriptSlot()
        }
        if (this.closing) return
        if (!result.ok) return await this.retryInbound(item, result.error)
        const output = result.stdout.trim()
        if (!output) return await this.finishInbound(key)
        item.output = output
      }
      const dir = await this.writeInboundFiles(event, item.output)
      await this.inboundStore.save({ ...item, turnStarted: true })
      item.turnStarted = true
      if (this.closing) return
      const routed = inboundRoutedEvent(item.trackingId, event, item.output, dir)
      const turn = new AbortController()
      this.inboundTurns.add(turn)
      const timeout = `Agent turn did not finish within ${INBOUND_TURN_TIMEOUT_MS / 60_000} minutes`
      const bound = setTimeout(() => turn.abort(new Error(timeout)), INBOUND_TURN_TIMEOUT_MS)
      bound.unref?.()
      try {
        await this.agents.run(routed.routeKey, renderChannelEvent(routed, this.config), {
          failOnError: true,
          signal: turn.signal,
        })
      } catch (error) {
        // A shutdown leaves the turn marked started; the next start reports it.
        if (this.closing) return
        if (turn.signal.aborted) return await this.reportInbound(item, timeout)
        return await this.reportInbound(item, error instanceof Error ? error.message : String(error))
      } finally {
        clearTimeout(bound)
        this.inboundTurns.delete(turn)
      }
      await this.finishInbound(key)
    } catch (error) {
      this.log.error('[inkbox] inbound event handling failed', error)
      if (item.report) item.report.dueAt = Date.now() + 10_000
      else item.dueAt = Date.now() + 10_000
      this.scheduleInbound(item)
    }
  }

  private async retryInbound(item: PendingInbound, error: string): Promise<void> {
    const delay = INBOUND_RETRY_DELAYS_MS[item.attempts - 1]
    if (delay === undefined) {
      this.log.warn('[inkbox] inbound script failed after every retry')
      return await this.reportInbound(item, error)
    }
    this.log.warn('[inkbox] inbound script failed; retry scheduled')
    item.dueAt = Date.now() + delay
    await this.inboundStore.save(item)
    this.scheduleInbound(item)
  }

  private async reportInbound(item: PendingInbound, error: string): Promise<void> {
    const now = Date.now()
    item.report = { error: error.slice(-INBOUND_REPORT_ERROR_MAX_CHARS), attempts: 0, dueAt: now }
    await this.inboundStore.save(item)
    this.scheduleInbound(item)
  }

  private async sendInboundReport(item: PendingInbound): Promise<void> {
    const report = item.report
    if (report === undefined) return
    if (this.identity === undefined) throw new Error('Gateway identity is unavailable')
    const { event } = item
    if (this.client === undefined) throw new Error('Gateway client is unavailable')
    try {
      await this.client.inbound.reportInboundEventResult(
        this.identity.agentHandle,
        event.sourceId,
        event.eventId,
        {
          status: 'failed',
          error: report.error,
          deliveryId: event.deliveryId,
        },
      )
    } catch (error) {
      // 4xx is final: 409 stale_delivery means a newer delivery owns the event.
      const final =
        error instanceof InkboxAPIError &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        ![408, 429].includes(error.statusCode)
      if (!final) {
        report.attempts += 1
        report.dueAt = Date.now() + deliveryRetryDelay(report.attempts)
        await this.inboundStore.save(item)
        this.scheduleInbound(item)
        return
      }
    }
    await this.finishInbound(event.deliveryId)
  }

  /** Returns the event directory, or undefined when the files could not be written. */
  private async writeInboundFiles(
    event: InboundEvent,
    output: string | undefined,
  ): Promise<string | undefined> {
    try {
      return await writeInboundFiles(
        this.inboundFiles,
        event,
        output === undefined ? inboundBodyBytes(event) : Buffer.from(output),
      )
    } catch (error) {
      this.log.warn('[inkbox] inbound event files could not be written', error)
      return undefined
    }
  }

  private async finishInbound(key: string): Promise<void> {
    await this.inboundStore.remove(key)
    this.inbound.delete(key)
  }

  private voiceNoteInbox(): VoiceNoteInbox {
    if (this.voiceNotes) return this.voiceNotes
    this.voiceNotes = new VoiceNoteInbox({
      path: join(
        this.config.stateDir,
        `voice-notes-${encodeURIComponent(this.identity?.id ?? 'uninitialized')}.json`,
      ),
      poll: async (event) => {
        if (!this.client || !this.identity) return undefined
        return pollVoiceNote(event, {
          apiKey: this.client._apiKey,
          baseUrl: this.client._baseUrl,
          identity: async () => this.identity!,
        })
      },
      deliver: async (event) => {
        await this.dispatchVerified(event, 'inkbox', true)
      },
      warn: () => this.log.warn('[inkbox] voice-note delivery retained'),
    })
    return this.voiceNotes
  }

  async handleWebSocket(ws: InkboxWebSocket): Promise<void> {
    const url = new URL(ws.url)
    if (url.pathname !== '/phone/media/ws') throw new Error('WebSocket path is not available')
    if (!this.config.voiceEnabled || this.config.voiceStack !== 'openai_realtime')
      throw new Error('OpenAI Realtime phone-call handling is not enabled')
    if (!this.signingKey || !authenticateCallWebSocket(ws, this.signingKey))
      throw new Error('Call WebSocket authentication failed')
    if (!this.identity) throw new Error('Gateway identity is unavailable')
    const apiKey = await this.runtime.resolveRealtimeKey()
    if (!apiKey) throw new Error(`${this.config.realtimeCredentialRef} is not configured`)
    const meta = await loadCallMeta(ws, this.identity, this.config.stateDir, this.client)
    const routeKey =
      meta.direction === 'inbound'
        ? `call:${meta.callId}`
        : meta.contactId
          ? `contact:${meta.contactId}`
          : routeForAddress(meta.remotePhoneNumber ?? `call:${meta.callId}`, this.state.snapshot().routingKey)
    const instructionRouteKey = meta.contactId ? `contact:${meta.contactId}` : routeKey
    const openai = await connectOpenAIRealtime(
      {
        apiKey,
        model: this.config.realtimeModel,
        voice: this.config.realtimeVoice,
        additionalInstructions: resolveChannelInstruction(
          { channel: 'call', routeKey: instructionRouteKey },
          this.config.channelInstructions,
        ),
      },
      meta,
    )
    const ready = await awaitRealtimeReady(openai)
    if (!ready.ok) {
      await openai.close().catch(() => {})
      throw new Error(ready.detail)
    }
    await runRealtimeBridge(ws, openai, meta, {
      consult: async (query, transcript) =>
        this.agents.run(
          routeKey,
          renderChannelEvent(
            {
              eventId: `${meta.callId}:consult`,
              routeKey: instructionRouteKey,
              channel: 'call',
              context: `[inkbox:live_call call_id=${meta.callId}]`,
              content: `${renderTranscript(transcript)}\n\nCaller request: ${query}`,
              replyText: query,
              target: { channel: 'none' },
            },
            this.config,
          ),
        ),
      ended: async (transcript, actions) => {
        if (transcript.length === 0 && actions.length === 0) return
        if (!(await this.claimCallReconciliation(meta.callId))) return
        const actionText = actions.length
          ? `\n\nExplicit post-call actions:\n${actions
              .map(
                (action, index) =>
                  `${index + 1}. ${action.action}${action.details ? ` — ${action.details}` : ''}`,
              )
              .join('\n')}`
          : ''
        await this.agents.run(
          routeKey,
          renderChannelEvent(
            {
              eventId: `${meta.callId}:ended`,
              routeKey: instructionRouteKey,
              channel: 'call',
              context: `[inkbox:realtime_call_ended call_id=${meta.callId}]\nReconcile the call and complete each explicit post-call action exactly once. Return [SILENT] if no visible channel response is needed.`,
              content: `${renderTranscript(transcript)}${actionText}`,
              replyText: renderTranscript(transcript),
              target: { channel: 'none' },
            },
            this.config,
          ),
        )
      },
    })
  }

  async askApproval(agent: Agent, prompt: string, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const answer = await this.askHuman(
      agent,
      `Approval required: ${prompt}\nReply YES to allow once, or NO to reject.`,
      'approval',
      signal,
    ).catch(() => '')
    return /^(yes|y|allow|approve|approved)\b/i.test(answer.trim())
      ? 'allowed-once'
      : signal?.aborted
        ? 'cancelled'
        : 'rejected'
  }

  async askQuestions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.agent === undefined) throw new Error('Inkbox questions require an active channel agent')
    const rendered = request.questions
      .map((question) => {
        const options = question.options?.map((option) => option.label).join(' / ')
        return `${question.header ? `${question.header}: ` : ''}${question.question}${options ? ` (${options})` : ''}`
      })
      .join('\n')
    const answer = await this.askHuman(request.agent, rendered, 'question', request.signal)
    return {
      answers: request.questions.map((question) => ({ id: question.id, selected: [], custom: answer })),
    }
  }

  status(): GatewayStatus {
    return {
      ready: this.signingKey !== undefined && (this.localDelivery || this.listener?.isConnected === true),
      ...(this.listener ? { publicUrl: this.listener.publicUrl } : {}),
      connected: this.listener?.isConnected ?? false,
      identity: this.identity?.agentHandle ?? this.config.agentHandle ?? 'unconfigured',
      slack: this.config.slackEnabled ? this.slackConnection : 'disabled',
      startedAt: this.startedAt,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    }
  }

  eventState(eventId: string): 'absent' | 'pending' | 'completed' | 'failed' | 'uncertain' {
    const state = this.state.snapshot()
    if (state.replied[eventId] !== undefined) return 'completed'
    for (const [id, delivery] of Object.entries(state.deliveries)) {
      if (!delivery.eventIds.includes(eventId)) continue
      if (delivery.state === 'rejected' || delivery.state === 'quarantined') return 'failed'
      return delivery.state === 'ready' || this.activeDeliveries.has(id) ? 'pending' : 'uncertain'
    }
    for (const queue of this.queues.values()) {
      if (
        queue.buffered.some((event) => event.eventId === eventId) ||
        queue.active?.events.some((event) => event.eventId === eventId)
      )
        return 'pending'
    }
    return state.seen[eventId] === undefined ? 'absent' : 'uncertain'
  }

  async quarantineDelivery(eventId: string): Promise<void> {
    if (
      [...this.queues.values()].some(
        (queue) =>
          queue.active?.events.some((event) => event.eventId === eventId) ||
          queue.buffered.some((event) => event.eventId === eventId),
      )
    )
      throw new Error('Delivery still has active work')
    await this.state.mutate((state) => {
      for (const [id, delivery] of Object.entries(state.deliveries)) {
        if (!delivery.eventIds.includes(eventId)) continue
        if (this.activeDeliveries.has(id) || delivery.state === 'ready')
          throw new Error('Delivery still has active work')
        delivery.state = 'quarantined'
      }
    })
  }

  activity(): {
    active: number
    buffered: number
    deliveries: number
    uncertain: number
    interactions: number
  } {
    const deliveries = Object.entries(this.state.snapshot().deliveries)
    return {
      // Pending failure reports do not keep the gateway awake.
      active: this.inflight.size + [...this.inbound.values()].filter((item) => !item.report).length,
      buffered: [...this.queues.values()].reduce((count, queue) => count + queue.buffered.length, 0),
      deliveries: deliveries.filter(([id, item]) => item.state === 'ready' || this.activeDeliveries.has(id))
        .length,
      uncertain: deliveries.filter(
        ([id, item]) =>
          !['ready', 'rejected', 'quarantined'].includes(item.state ?? '') && !this.activeDeliveries.has(id),
      ).length,
      interactions: this.pendingHuman.size,
    }
  }

  replySource(agent: Agent): RoutedEvent | undefined {
    const route = this.agents.routeForAgent(agent)
    return route ? this.queues.get(route)?.active?.events.at(-1) : undefined
  }

  ownsAgent(agent: Agent): boolean {
    return this.agents.routeForAgent(agent) !== undefined
  }

  async close(): Promise<void> {
    this.voiceNotes?.close()
    if (this.closing) return
    this.closing = true
    for (const queue of this.queues.values()) if (queue.timer !== undefined) clearTimeout(queue.timer)
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
    for (const timer of this.inboundTimers.values()) clearTimeout(timer)
    this.inboundTimers.clear()
    if (this.inboundReload) clearTimeout(this.inboundReload)
    clearInterval(this.inboundSweep)
    for (const turn of this.inboundTurns) turn.abort(new Error('Gateway stopped'))
    this.stopAllTyping()
    for (const pending of this.pendingHuman.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Gateway stopped'))
    }
    this.pendingHuman.clear()
    await this.listener?.aclose()
    await Promise.allSettled([...this.inflight])
    await this.agents.close()
    await this.writeStatus(false)
  }

  private async accept(event: RoutedEvent): Promise<void> {
    this.latestTargets.set(event.routeKey, event.target)
    this.latestAuthors.set(
      event.routeKey,
      event.sender ? { channel: event.channel, sender: event.sender } : undefined,
    )
    const pending = this.pendingHuman.get(event.routeKey)
    // Only the participant who prompted the turn can answer it.
    if (pending !== undefined && event.replyText.trim() && sameAuthor(pending.author, event)) {
      this.pendingHuman.delete(event.routeKey)
      clearTimeout(pending.timer)
      pending.resolve(event.replyText.trim())
      await this.state.mutate((state) => {
        state.replied[event.eventId] = Date.now()
      })
      return
    }
    const queue = this.queues.get(event.routeKey) ?? { buffered: [], timer: undefined, active: undefined }
    this.queues.set(event.routeKey, queue)
    if (event.typingConversationId) this.startTyping(event.typingConversationId)
    if (queue.active?.phase === 'generating') {
      queue.active.events.push(event)
      queue.active.target = event.target
      const task = this.agents
        .steer(event.routeKey, renderChannelEvent(event, this.config))
        .catch((error) => this.log.error('[inkbox] steer failed', error))
      this.track(task)
      return
    }
    queue.buffered.push(event)
    if (queue.timer !== undefined) clearTimeout(queue.timer)
    queue.timer = setTimeout(() => {
      queue.timer = undefined
      const task = this.runBatch(event.routeKey, queue)
      this.track(task)
    }, this.config.batchWindowMs)
  }

  private async runBatch(routeKey: string, queue: Queue): Promise<void> {
    if (this.closing || queue.active !== undefined || queue.buffered.length === 0) return
    const events = queue.buffered.splice(0)
    const active: NonNullable<Queue['active']> = {
      events,
      target: events.at(-1)?.target ?? { channel: 'none' as const },
      phase: 'generating',
    }
    queue.active = active
    try {
      const prompt = events.map((event) => renderChannelEvent(event, this.config)).join('\n\n')
      const response = (await this.agents.run(routeKey, prompt)).trim()
      this.stopTypingForEvents(active.events)
      if (active.stopped) {
        await this.state.mutate((state) => {
          for (const event of active.events) state.replied[event.eventId] = Date.now()
        })
        return
      }
      active.phase = 'finishing'
      const source = active.events.at(-1)
      const terminal = this.runtime.remoteTools && source ? await replyState(this.runtime, source) : 'none'
      if (terminal === 'uncertain') return
      const eventIds = active.events.map((event) => event.eventId)
      if (
        response &&
        !isSilentResponse(response) &&
        active.target.channel !== 'none' &&
        terminal !== 'accepted'
      ) {
        const deliveryId = eventIds.at(-1)
        if (deliveryId === undefined) throw new Error('Cannot persist a delivery without an event')
        await this.state.mutate((state) => {
          state.deliveries[deliveryId] = {
            state: 'ready',
            eventIds,
            target: active.target,
            response,
            attempts: 0,
            nextAttemptAt: Date.now(),
          }
        })
        await this.attemptDelivery(deliveryId)
      } else {
        await this.state.mutate((state) => {
          for (const eventId of eventIds) state.replied[eventId] = Date.now()
        })
      }
    } catch (error) {
      this.stopTypingForEvents(active.events)
      this.log.error('[inkbox] inbound turn failed', error)
    } finally {
      if (queue.active === active) queue.active = undefined
      if (queue.buffered.length > 0 && !this.closing) {
        const task = this.runBatch(routeKey, queue)
        this.track(task)
      }
    }
  }

  private async deliver(target: ReplyTarget, response: string): Promise<void> {
    const identity = this.identity
    if (identity === undefined) throw new Error('Gateway identity is unavailable')
    switch (target.channel) {
      case 'email':
        await identity.sendEmail({
          to: [target.to],
          subject: target.subject,
          bodyText: response,
          ...(target.inReplyToMessageId ? { inReplyToMessageId: target.inReplyToMessageId } : {}),
        })
        return
      case 'sms':
        if (target.conversationId !== undefined)
          await identity.sendText({ conversationId: target.conversationId, text: response })
        else if (target.to !== undefined) await identity.sendText({ to: target.to, text: response })
        else throw new Error('SMS reply target is missing both conversation and recipient')
        return
      case 'imessage': {
        const text = toIMessagePlainText(response)
        if (!text) return
        await identity.sendIMessage({
          conversationId: target.conversationId,
          text,
        })
        return
      }
      case 'whatsapp':
        await identity.sendWhatsApp({ conversationId: target.conversationId, text: response })
        return
      case 'slack':
        if (this.client === undefined) throw new Error('Gateway client is unavailable')
        await sendSlackReply(this.client, target, response)
        return
      case 'none':
        return
    }
  }

  private startTyping(conversationId: string): void {
    if (this.typingPulses.has(conversationId)) return
    const pulse: TypingPulse = { deadline: Date.now() + IMESSAGE_TYPING_MAX_MS }
    this.typingPulses.set(conversationId, pulse)
    this.track(this.sendTypingPulse(conversationId, pulse))
  }

  private async sendTypingPulse(conversationId: string, pulse: TypingPulse): Promise<void> {
    if (this.closing || this.typingPulses.get(conversationId) !== pulse) return
    if (Date.now() >= pulse.deadline) {
      this.stopTyping(conversationId)
      return
    }
    try {
      await this.identity?.sendIMessageTyping(conversationId)
    } catch (error) {
      this.log.warn('[inkbox] iMessage typing pulse failed', error)
    }
    if (this.closing || this.typingPulses.get(conversationId) !== pulse) return
    const delay = Math.min(IMESSAGE_TYPING_REFRESH_MS, Math.max(0, pulse.deadline - Date.now()))
    pulse.timer = setTimeout(() => this.track(this.sendTypingPulse(conversationId, pulse)), delay)
  }

  private stopTyping(conversationId: string): void {
    const pulse = this.typingPulses.get(conversationId)
    if (!pulse) return
    if (pulse.timer) clearTimeout(pulse.timer)
    this.typingPulses.delete(conversationId)
  }

  private stopTypingForEvents(events: readonly RoutedEvent[]): void {
    for (const event of events) if (event.typingConversationId) this.stopTyping(event.typingConversationId)
  }

  private stopAllTyping(): void {
    for (const conversationId of this.typingPulses.keys()) this.stopTyping(conversationId)
  }

  resumeDeliveries(): void {
    for (const [deliveryId, pending] of Object.entries(this.state.snapshot().deliveries)) {
      this.scheduleDelivery(deliveryId, Math.max(0, pending.nextAttemptAt - Date.now()))
    }
    for (const item of this.inbound.values()) this.scheduleInbound(item)
  }

  private scheduleDelivery(deliveryId: string, delay: number): void {
    if (this.closing || this.deliveryTimers.has(deliveryId)) return
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(deliveryId)
      const task = this.attemptDelivery(deliveryId)
      this.track(task)
    }, delay)
    this.deliveryTimers.set(deliveryId, timer)
  }

  private async attemptDelivery(deliveryId: string): Promise<void> {
    if (this.closing || this.activeDeliveries.has(deliveryId)) return
    const pending = this.state.snapshot().deliveries[deliveryId]
    if (pending === undefined || pending.state !== 'ready') return
    // A disabled channel keeps its saved reply unsubmitted until it is enabled again.
    if (pending.target.channel === 'slack' && !this.config.slackEnabled) return
    this.activeDeliveries.add(deliveryId)
    try {
      let send: () => Promise<void>
      try {
        send = await this.prepareDelivery(pending.target, pending.response)
      } catch (error) {
        // Nothing was sent: a temporary read retries, anything else is refused.
        const retryable = retryableRead(error)
        this.log.warn(
          retryable
            ? '[inkbox] delivery check failed; retry scheduled'
            : '[inkbox] delivery refused before sending',
        )
        const next = await this.state.mutate((state) => {
          const current = state.deliveries[deliveryId]
          if (current === undefined) return undefined
          current.attempts += 1
          if (!retryable) {
            current.state = 'rejected'
            return undefined
          }
          current.nextAttemptAt = Date.now() + deliveryRetryDelay(current.attempts)
          return current.nextAttemptAt
        })
        if (next !== undefined) this.scheduleDelivery(deliveryId, Math.max(0, next - Date.now()))
        return
      }
      await this.state.mutate((state) => {
        const current = state.deliveries[deliveryId]
        if (current) current.state = 'submitted'
      })
      await send()
      await this.state.mutate((state) => {
        const current = state.deliveries[deliveryId]
        if (current === undefined) return
        const now = Date.now()
        for (const eventId of current.eventIds) state.replied[eventId] = now
        delete state.deliveries[deliveryId]
      })
    } catch (error) {
      const retryable = error instanceof InkboxAPIError && error.statusCode === 429
      const rejected =
        error instanceof InkboxAPIError &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        ![408, 409].includes(error.statusCode)
      this.log.warn(
        retryable
          ? '[inkbox] delivery rejected; retry scheduled'
          : '[inkbox] delivery outcome requires attention',
      )
      const next = await this.state.mutate((state) => {
        const current = state.deliveries[deliveryId]
        if (current === undefined) return undefined
        current.state = retryable ? 'ready' : rejected ? 'rejected' : 'uncertain'
        current.attempts += 1
        if (!retryable) return undefined
        current.nextAttemptAt = Date.now() + deliveryRetryDelay(current.attempts)
        return current.nextAttemptAt
      })
      if (next !== undefined) this.scheduleDelivery(deliveryId, Math.max(0, next - Date.now()))
    } finally {
      this.activeDeliveries.delete(deliveryId)
    }
  }

  /** Checks that must pass before a reply is marked submitted; the returned function sends it. */
  private async prepareDelivery(target: ReplyTarget, response: string): Promise<() => Promise<void>> {
    if (target.channel !== 'slack') return () => this.deliver(target, response)
    if (this.client === undefined) throw new Error('Gateway client is unavailable')
    const send = await prepareSlackReply(this.client, target, response)
    return async () => {
      await send()
    }
  }

  private async askHuman(
    agent: Agent,
    prompt: string,
    kind: PendingHuman['kind'],
    signal?: AbortSignal,
  ): Promise<string> {
    const routeKey = this.agents.routeForAgent(agent)
    if (routeKey === undefined) throw new Error('No active Inkbox route owns this agent')
    if (this.pendingHuman.has(routeKey))
      throw new Error('Another Inkbox interaction is already pending for this route')
    const target = this.latestTargets.get(routeKey)
    if (target === undefined || target.channel === 'none')
      throw new Error('The active route has no reply channel')
    // Captured before sending so a later participant cannot become the answerer.
    const author = this.latestAuthors.get(routeKey)
    await this.deliver(target, prompt)
    return new Promise<string>((resolve, reject) => {
      const finish = (error: Error) => {
        const current = this.pendingHuman.get(routeKey)
        if (current !== undefined) clearTimeout(current.timer)
        this.pendingHuman.delete(routeKey)
        reject(error)
      }
      const timer = setTimeout(
        () => finish(new Error('Timed out waiting for a channel reply')),
        this.config.permissionTimeoutMs,
      )
      this.pendingHuman.set(routeKey, { kind, ...(author ? { author } : {}), resolve, reject, timer })
      if (signal !== undefined) {
        const abort = () =>
          finish(signal.reason instanceof Error ? signal.reason : new Error('Interaction cancelled'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }
    })
  }

  private async reconcileSubscriptions(publicUrl: string): Promise<void> {
    if (this.client === undefined || this.identity === undefined)
      throw new Error('Gateway client is unavailable')
    const url = `${publicUrl.replace(/\/$/, '')}/webhook`
    const specs: Array<{
      owner: { mailboxId?: string; phoneNumberId?: string; agentIdentityId?: string }
      events: readonly string[]
    }> = []
    if (this.identity.mailbox?.id)
      specs.push({ owner: { mailboxId: this.identity.mailbox.id }, events: EVENT_TYPES.email })
    if (this.identity.phoneNumber?.id)
      specs.push({ owner: { phoneNumberId: this.identity.phoneNumber.id }, events: EVENT_TYPES.sms })
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: [TRANSCRIPTION_FINISHED] })
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: EVENT_TYPES.imessage })
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: EVENT_TYPES.whatsapp })
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: EVENT_TYPES.call })
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: EVENT_TYPES.a2a })

    for (const spec of specs) {
      const transcription = spec.events.includes(TRANSCRIPTION_FINISHED)
      const whatsapp = spec.events === EVENT_TYPES.whatsapp
      const filter = {
        ...spec.owner,
        url,
        ...(transcription || whatsapp ? { scope: 'identity' as const } : {}),
      }
      const subscriptions = this.client.webhooks.subscriptions
      const existing = await subscriptions.list(filter)
      const match = existing.find((subscription) =>
        subscription.eventTypes.some((event) => spec.events.includes(event)),
      )
      if (match !== undefined) {
        if (transcription || whatsapp) continue // Preserve other events on a shared receiver.
        const same =
          match.eventTypes.length === spec.events.length &&
          spec.events.every((event) => match.eventTypes.includes(event))
        if (!same) await this.client.webhooks.subscriptions.update(match.id, { eventTypes: [...spec.events] })
        continue
      }
      const created = await subscriptions
        .create({
          ...spec.owner,
          url,
          eventTypes: [...spec.events],
        })
        .catch(async (error: unknown) => {
          if (transcription && transcriptionEventUnsupported(error)) {
            this.log.warn('[inkbox] transcription callbacks are unavailable on this API version')
            return undefined
          }
          if (!whatsapp || !(error instanceof InkboxAPIError) || error.statusCode !== 409) throw error
          const rows = await subscriptions.list(filter)
          if (!rows.some((row) => row.eventTypes.includes('whatsapp.received'))) throw error
          return undefined
        })
      if (!created) continue
      if (created.signingKey !== null && this.signingKey === undefined) {
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
        await this.ctx.credentials.set(credentialRef(this.config.signingKeyRef), created.signingKey)
        this.signingKey = created.signingKey
      }
    }
    if (this.config.slackEnabled) await reconcileSlackSubscription(this.client, this.identity.id, url)
  }

  private track(promise: Promise<void>): void {
    this.inflight.add(promise)
    void promise.finally(() => this.inflight.delete(promise))
  }

  private claimCallReconciliation(callId: string): Promise<boolean> {
    const marker = `call-reconciled:${callId}`
    return this.state.mutate((state) => {
      if (state.seen[marker] !== undefined) return false
      state.seen[marker] = Date.now()
      return true
    })
  }

  private async writeStatus(ready: boolean): Promise<void> {
    const path = join(this.config.stateDir, 'status.json')
    await writeFile(path, `${JSON.stringify({ ...this.status(), ready })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
}

function sameAuthor(expected: ReplyAuthor | undefined, event: RoutedEvent): boolean {
  if (expected === undefined) return true
  if (event.channel !== expected.channel || event.sender === undefined) return false
  return expected.channel === 'email'
    ? event.sender.trim().toLowerCase() === expected.sender.trim().toLowerCase()
    : event.sender === expected.sender
}

export function isSilentResponse(response: string): boolean {
  return response.trim().endsWith('[SILENT]')
}

// Reads made before a Slack message is admitted. A timeout, network failure,
// 408, 429 or 5xx leaves the message unadmitted so it can be delivered again; a
// denial and every other error stay final.
async function readBeforeAdmission<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof SlackConnectionDenied || !retryableRead(error)) throw error
    throw new VoiceNoteNotAdmitted('Slack is temporarily unavailable.', { cause: error })
  }
}

function deliveryRetryDelay(attempt: number): number {
  return Math.min(3_600_000, 1_000 * 2 ** Math.min(attempt - 1, 12))
}

function renderTranscript(transcript: readonly TranscriptTurn[]): string {
  if (transcript.length === 0) return '(No final transcript was available.)'
  return transcript.map((turn) => `${turn.party === 'agent' ? 'Agent' : 'Caller'}: ${turn.text}`).join('\n')
}

function endedCallId(payload: Record<string, unknown>): string | undefined {
  if (payload.event_type !== 'call.ended') return undefined
  const data =
    typeof payload.data === 'object' && payload.data !== null ? (payload.data as Record<string, unknown>) : {}
  const call =
    typeof data.call === 'object' && data.call !== null ? (data.call as Record<string, unknown>) : {}
  const value = call.id ?? data.call_id
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
