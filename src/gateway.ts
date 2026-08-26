import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { AgentIdentity, Inkbox } from '@inkbox/sdk'
import { connect, type InkboxWebSocket, type TunnelListener } from '@inkbox/sdk/tunnels/connect'
import { AgentManager } from './agent-manager.js'
import { renderChannelEvent, resolveChannelInstruction } from './channel-instructions.js'
import type { ResolvedConfig } from './config.js'
import {
  authenticateCallWebSocket,
  awaitRealtimeReady,
  connectOpenAIRealtime,
  loadCallMeta,
  runRealtimeBridge,
  type TranscriptTurn,
} from './realtime.js'
import { type ReplyTarget, type RoutedEvent, routeForAddress, routeWebhook } from './routing.js'
import type { InkboxRuntime } from './runtime.js'
import { StateStore } from './state.js'
import { authenticateWebhook } from './webhook-providers.js'

interface Queue {
  buffered: RoutedEvent[]
  timer: ReturnType<typeof setTimeout> | undefined
  active: { events: RoutedEvent[]; target: ReplyTarget } | undefined
}

interface PendingHuman {
  kind: 'approval' | 'question'
  resolve(value: string): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

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
  call: ['call.ended'],
  a2a: ['a2a.task.created', 'a2a.task.message', 'a2a.task.canceled', 'a2a.sent_task.updated'],
} as const

export interface GatewayStatus {
  ready: boolean
  publicUrl?: string
  connected: boolean
  identity: string
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
  private readonly queues = new Map<string, Queue>()
  private readonly latestTargets = new Map<string, ReplyTarget>()
  private readonly pendingHuman = new Map<string, PendingHuman>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly activeDeliveries = new Set<string>()
  private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly startedAt = new Date().toISOString()

  constructor(
    private readonly ctx: Context,
    private readonly runtime: InkboxRuntime,
    private readonly config: ResolvedConfig,
    private readonly log: Pick<Console, 'info' | 'warn' | 'error'> = console,
  ) {
    this.state = new StateStore(join(config.stateDir, 'gateway-state.json'))
    this.agents = new AgentManager(ctx, config, this.state)
  }

  async start(): Promise<void> {
    await this.state.initialize()
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
    this.client = await this.runtime.getClient()
    this.identity = await this.runtime.getIdentity()
    this.signingKey = await this.runtime.resolveSigningKey()
    if (this.config.externalEvents) {
      this.githubWebhookSecret = (
        await this.ctx.credentials.resolve(credentialRef(this.config.githubWebhookSecretRef))
      )?.value
    }

    let connectedResolve: (() => void) | undefined
    const connected = new Promise<void>((resolve) => {
      connectedResolve = resolve
    })
    this.listener = await connect(this.client, {
      name: this.identity.agentHandle,
      stateDir: join(this.config.stateDir, 'tunnel'),
      installSignalHandlers: false,
      handler: (request) => this.handleRequest(request),
      wsHandler: (ws) => this.handleWebSocket(ws),
      onStatus: (status) => {
        this.log.info(`[inkbox] tunnel ${status}`)
        if (status === 'connected') connectedResolve?.()
      },
    })
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
    await this.writeStatus(true)
    void this.tunnelTask.catch((error) => {
      if (!this.closing) this.log.error('[inkbox] tunnel stopped unexpectedly', error)
    })
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(this.status(), { status: this.listener?.isConnected ? 200 : 503 })
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
    const callId = endedCallId(authenticated.payload)
    if (callId && !(await this.claimCallReconciliation(callId)))
      return new Response('Duplicate', { status: 200 })
    const routed = routeWebhook(
      authenticated.payload,
      this.state.snapshot().routingKey,
      authenticated.source !== 'inkbox' || this.config.externalEvents,
    )
    if (routed === undefined) return new Response('Ignored', { status: 202 })
    const accepted = await this.state.mutate((state) => {
      if (state.seen[routed.eventId] !== undefined) return false
      state.seen[routed.eventId] = Date.now()
      return true
    })
    if (!accepted) return new Response('Duplicate', { status: 200 })
    this.accept(routed)
    return new Response('Accepted', { status: 202 })
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
      ready: this.signingKey !== undefined && this.listener?.isConnected === true,
      ...(this.listener ? { publicUrl: this.listener.publicUrl } : {}),
      connected: this.listener?.isConnected ?? false,
      identity: this.identity?.agentHandle ?? this.config.agentHandle ?? 'unconfigured',
      startedAt: this.startedAt,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    }
  }

  ownsAgent(agent: Agent): boolean {
    return this.agents.routeForAgent(agent) !== undefined
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const queue of this.queues.values()) if (queue.timer !== undefined) clearTimeout(queue.timer)
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
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

  private accept(event: RoutedEvent): void {
    this.latestTargets.set(event.routeKey, event.target)
    const pending = this.pendingHuman.get(event.routeKey)
    if (pending !== undefined) {
      this.pendingHuman.delete(event.routeKey)
      clearTimeout(pending.timer)
      pending.resolve(event.replyText.trim())
      return
    }
    const queue = this.queues.get(event.routeKey) ?? { buffered: [], timer: undefined, active: undefined }
    this.queues.set(event.routeKey, queue)
    if (queue.active !== undefined) {
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
    const active = { events, target: events.at(-1)?.target ?? { channel: 'none' as const } }
    queue.active = active
    try {
      const prompt = events.map((event) => renderChannelEvent(event, this.config)).join('\n\n')
      const response = (await this.agents.run(routeKey, prompt)).trim()
      if (queue.active === active) queue.active = undefined
      const eventIds = active.events.map((event) => event.eventId)
      if (response && !isSilentResponse(response) && active.target.channel !== 'none') {
        const deliveryId = eventIds.at(-1)
        if (deliveryId === undefined) throw new Error('Cannot persist a delivery without an event')
        await this.state.mutate((state) => {
          state.deliveries[deliveryId] = {
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
      case 'imessage':
        await identity.sendIMessage({ conversationId: target.conversationId, text: response })
        return
      case 'none':
        return
    }
  }

  private resumeDeliveries(): void {
    for (const [deliveryId, pending] of Object.entries(this.state.snapshot().deliveries)) {
      this.scheduleDelivery(deliveryId, Math.max(0, pending.nextAttemptAt - Date.now()))
    }
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
    if (pending === undefined) return
    this.activeDeliveries.add(deliveryId)
    try {
      await this.deliver(pending.target, pending.response)
      await this.state.mutate((state) => {
        const current = state.deliveries[deliveryId]
        if (current === undefined) return
        const now = Date.now()
        for (const eventId of current.eventIds) state.replied[eventId] = now
        delete state.deliveries[deliveryId]
      })
    } catch (error) {
      this.log.warn('[inkbox] delivery failed; retry scheduled', error)
      const next = await this.state.mutate((state) => {
        const current = state.deliveries[deliveryId]
        if (current === undefined) return undefined
        current.attempts += 1
        current.nextAttemptAt = Date.now() + deliveryRetryDelay(current.attempts)
        return current.nextAttemptAt
      })
      if (next !== undefined) this.scheduleDelivery(deliveryId, Math.max(0, next - Date.now()))
    } finally {
      this.activeDeliveries.delete(deliveryId)
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
      this.pendingHuman.set(routeKey, { kind, resolve, reject, timer })
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
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: EVENT_TYPES.imessage })
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: EVENT_TYPES.call })
    specs.push({ owner: { agentIdentityId: this.identity.id }, events: EVENT_TYPES.a2a })

    for (const spec of specs) {
      const existing = await this.client.webhooks.subscriptions.list({ ...spec.owner, url })
      const match = existing.find((subscription) =>
        subscription.eventTypes.some((event) => spec.events.includes(event)),
      )
      if (match !== undefined) {
        const same =
          match.eventTypes.length === spec.events.length &&
          spec.events.every((event) => match.eventTypes.includes(event))
        if (!same) await this.client.webhooks.subscriptions.update(match.id, { eventTypes: [...spec.events] })
        continue
      }
      const created = await this.client.webhooks.subscriptions.create({
        ...spec.owner,
        url,
        eventTypes: [...spec.events],
      })
      if (created.signingKey !== null && this.signingKey === undefined) {
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
        await this.ctx.credentials.set(credentialRef(this.config.signingKeyRef), created.signingKey)
        this.signingKey = created.signingKey
      }
    }
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

export function isSilentResponse(response: string): boolean {
  return response.trim().endsWith('[SILENT]')
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
