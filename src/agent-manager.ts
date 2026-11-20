import { createHmac } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  type Agent,
  type AgentHandle,
  installModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.js'
import type { RouteRecord, StateStore } from './state.js'

interface ManagedAgent {
  handle: AgentHandle
  routeKey: string
}

export class AgentManager {
  private readonly agents = new Map<string, ManagedAgent>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly state: StateStore,
  ) {}

  async get(routeKey: string): Promise<Agent> {
    const live = this.agents.get(routeKey)
    if (live !== undefined) return live.handle.agent
    const route = await this.routeRecord(routeKey)
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const setup = (agentCtx: Context) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    let handle: AgentHandle
    if (route.created) {
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(route.sessionId),
        agentOptions: { provider: selection.provider, model: selection.model },
        setup,
      })
    } else {
      try {
        handle = await this.ctx.agents.create({
          sessionId: SessionId(route.sessionId),
          meta: { cwd: this.config.workspace },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup,
        })
      } catch (createError) {
        try {
          handle = await this.ctx.agents.resume({
            resumeSessionId: SessionId(route.sessionId),
            agentOptions: { provider: selection.provider, model: selection.model },
            setup,
          })
        } catch {
          throw createError
        }
      }
      await this.state.mutate((current) => {
        const saved = current.routes[routeKey]
        if (saved !== undefined) saved.created = true
      })
    }
    this.agents.set(routeKey, { handle, routeKey })
    return handle.agent
  }

  /** An abort before submission skips the prompt; after it, the running turn is cancelled. */
  async run(
    routeKey: string,
    prompt: string,
    options: { failOnError?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    const { signal } = options
    const agent = await this.get(routeKey)
    await agent.whenIdle()
    signal?.throwIfAborted()
    const firstSeq = agent.session.seq
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'inkbox' },
      }),
    )
    const cancel = () => agent.cancel({ kind: 'hook', reason: 'inkbox turn aborted' })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      await settleAgent(this.ctx, agent)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
    await this.ctx.sessions.flush(agent.session)
    signal?.throwIfAborted()
    if (options.failOnError) {
      const failure = turnFailure(agent.session.events, firstSeq)
      if (failure !== undefined) throw new Error(failure)
    }
    return summarize(agent.session.events, firstSeq)
  }

  async steer(routeKey: string, prompt: string): Promise<void> {
    const agent = await this.get(routeKey)
    agent.steer(
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'inkbox' },
      }),
    )
  }

  routeForAgent(agent: Agent): string | undefined {
    for (const [routeKey, managed] of this.agents) if (managed.handle.agent === agent) return routeKey
    return undefined
  }

  async close(): Promise<void> {
    const handles = [...this.agents.values()].map((value) => value.handle)
    this.agents.clear()
    for (const handle of handles.reverse()) await handle.dispose()
  }

  private async routeRecord(routeKey: string): Promise<RouteRecord> {
    const snapshot = this.state.snapshot()
    const existing = snapshot.routes[routeKey]
    if (existing !== undefined) return existing
    const sessionId = `inkbox-${createHmac('sha256', snapshot.routingKey).update(routeKey).digest('hex').slice(0, 40)}`
    return this.state.mutate((current) => {
      const found = current.routes[routeKey]
      if (found !== undefined) return found
      const created = { sessionId, created: false }
      current.routes[routeKey] = created
      return created
    })
  }
}

export function summarize(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const candidate = event.data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
    if (candidate) text = candidate
  }
  return text
}

export function turnFailure(events: readonly SessionEvent[], firstSeq: number): string | undefined {
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'turn/end') continue
    const reason = event.data.reason
    if (reason.kind === 'error') return reason.error.message || 'Agent turn failed'
    if (reason.kind === 'aborted' || reason.kind === 'interrupted') return `Agent turn ${reason.kind}`
  }
  return undefined
}

interface OwnerJobs {
  list(agent: Agent): { id: string; ownerSession?: string; status: string }[]
  wait(id: string, timeoutMs: number, agent: Agent): Promise<unknown>
}

export async function settleAgent(ctx: Context, agent: Agent): Promise<void> {
  const jobs = (ctx as Context & { jobs?: OwnerJobs }).jobs
  for (;;) {
    await agent.whenIdle()
    await setImmediate()
    await agent.whenIdle()
    const pending =
      jobs
        ?.list(agent)
        .filter(
          (job) => job.ownerSession === agent.session.id && ['running', 'stopping'].includes(job.status),
        ) ?? []
    if (!pending.length) return
    await Promise.all(pending.map((job) => jobs!.wait(job.id, 1000, agent)))
  }
}
