import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { type RemoteCallOptions, RemoteMcp, type RemoteToolResult } from '@inkbox/sdk/remote-mcp'
import type { RoutedEvent } from './routing.js'
import type { InkboxRuntime } from './runtime.js'
import { terminalReply } from './terminal-reply.js'

type Descriptor = { name: string; [key: string]: unknown }
type Turn = { number: number; remote?: RemoteMcp; catalog: Descriptor[]; held?: boolean; signal: AbortSignal }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const names: Record<string, string> = {
  inkbox_lookup_contact: 'inkbox_contacts_list',
  inkbox_list_contacts: 'inkbox_contacts_list',
  inkbox_get_contact: 'inkbox_contact_get',
  inkbox_create_contact: 'inkbox_contact_create',
  inkbox_update_contact: 'inkbox_contact_update',
  inkbox_delete_contact: 'inkbox_contact_delete',
}
const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

export class RemoteTools {
  private readonly turns = new WeakMap<Agent, Turn>()
  private readonly dispose: (() => void)[] = []
  constructor(
    private readonly ctx: Context,
    private readonly runtime: InkboxRuntime,
    private readonly incoming: (agent: Agent) => boolean = () => false,
    private readonly source: (agent: Agent) => RoutedEvent | undefined = () => undefined,
  ) {}

  register(): void {
    this.registerReply()
    this.dispose.push(
      this.ctx.on('agent/pre-step', async (payload, next) => {
        await this.prepare(payload.agent, payload.turn, payload.signal)
        return next()
      }),
    )
    this.dispose.push(
      this.ctx.on('agent/turn-stopping', ({ agent }) => {
        this.turns.delete(agent)
      }),
    )
    this.dispose.push(
      this.ctx.tools.register(
        defineTool({
          name: 'inkbox_remote_tools',
          description:
            'Read the current Inkbox tool catalog, including full JSON schemas and annotations. Read a tool before calling it. New tools are available without a plugin update.',
          parameters: {
            name: { type: 'string', description: 'Optional exact tool name.' },
            offset: { type: 'integer', description: 'Catalog offset, starting at zero.' },
          },
          output,
          execute: async (args, exec) => {
            const turn = this.current(exec)
            if (!turn.remote) throw new Error('Remote tools are unavailable for this identity')
            const offset = args.offset ?? 0
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > turn.catalog.length)
              throw new Error('Invalid catalog offset')
            const tools = args.name
              ? turn.catalog.filter((tool) => tool.name === args.name)
              : turn.catalog.slice(offset, offset + 32)
            return {
              tools,
              next_offset: !args.name && offset + 32 < turn.catalog.length ? offset + 32 : null,
            } as unknown as JsonValue
          },
        }),
      ),
    )
    this.dispose.push(
      this.ctx.tools.register(
        defineTool({
          name: 'inkbox_remote_call',
          description:
            'Call a tool from inkbox_remote_tools using its exact name and full JSON arguments. Retains the native call identity when reconciling an uncertain result.',
          parameters: {
            name: { type: 'string', required: true, description: 'Exact discovered tool name.' },
            arguments: {
              type: 'object',
              required: true,
              additionalProperties: true,
              properties: {},
              description: 'Arguments matching the discovered JSON schema.',
            },
          },
          output,
          execute: async (args, exec) => this.call(args.name, args.arguments, exec),
        }),
      ),
    )
  }

  private registerReply(): void {
    this.dispose.push(
      this.ctx.tools.register(
        defineTool({
          name: 'inkbox_reply_current',
          description:
            'Send the final text reply to the original incoming email or direct SMS. The destination is fixed by the admitted message. Use ordinary tools for progress or unrelated messages.',
          parameters: {
            text: {
              type: 'string',
              required: true,
              description: 'Final reply text; reuse it when reconciling uncertainty.',
            },
          },
          output,
          execute: async (args, exec) => {
            const turn = this.current(exec)
            const event = exec.agent && this.source(exec.agent)
            if (!event || !turn.remote)
              throw new Error('A terminal reply requires the original incoming message')
            const validate = () => {
              if (this.current(exec) !== turn || !exec.agent || this.source(exec.agent) !== event)
                throw new Error('The original message was retired')
            }
            return (await terminalReply(
              turn.remote,
              this.runtime,
              event,
              args.text,
              validate,
              async (name, payload, operation, path, submit) =>
                this.call(name, payload, exec, {
                  callIdentity: operation,
                  journalPath: path,
                  beforeSubmit: submit,
                  beforeExecute: validate,
                }) as Promise<RemoteToolResult>,
            )) as JsonValue
          },
        }),
      ),
    )
  }

  async prepare(agent: Agent, number: number, signal: AbortSignal): Promise<void> {
    if (this.turns.get(agent)?.number === number) return
    const turn: Turn = { number, catalog: [], signal }
    this.turns.set(agent, turn)
    try {
      const client = await this.runtime.getClient()
      const account = await client.whoami()
      if (
        account.authSubtype === 'api_key.admin_scoped' ||
        account.authSubtype === 'api_key.agent_scoped.unclaimed'
      ) {
        turn.held = true
        return
      }
      if (account.authSubtype !== 'api_key.agent_scoped.claimed') return
      const identity = await this.runtime.getIdentity()
      const remote = new RemoteMcp({
        apiKey: client._apiKey,
        baseUrl: client._baseUrl,
        identity: identity.id,
        journalPath: join(this.runtime.config.stateDir, 'remote-calls', hash(agent.session.id)),
      })
      const catalog = await remote.refresh({ signal })
      if (signal.aborted || this.turns.get(agent) !== turn) return
      turn.remote = remote
      turn.catalog = catalog
    } catch {
      // Existing local capabilities remain available; remote aliases fail closed.
    }
  }

  private current(exec: ToolRunContext): Turn {
    const turn = exec.agent && this.turns.get(exec.agent)
    if (!turn || exec.signal.aborted || turn.signal.aborted)
      throw new Error('The native turn no longer authorizes this tool')
    return turn
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    exec: ToolRunContext,
    options: Partial<RemoteCallOptions> = {},
  ): Promise<JsonValue> {
    const turn = this.current(exec)
    if (!exec.agent || !turn.remote || !exec.callId)
      throw new Error('Remote tools require a current native call identity')
    const agent = exec.agent
    if (!this.incoming(agent) && !this.runtime.config.autoApproveInkboxTools) {
      const result = await this.ctx.approval.request({
        agent,
        toolName: name,
        callId: exec.callId,
        reason: `Run Inkbox tool ${name}`,
        signal: exec.signal,
      })
      if (result !== 'allowed-once') throw new Error('The remote tool was not approved')
    }
    const validate = async () => {
      if (this.current(exec) !== turn) throw new Error('The native turn was replaced')
      await options.beforeExecute?.()
    }
    await validate()
    return (await turn.remote.call(name, args, {
      ...options,
      callIdentity: options.callIdentity ?? hash([agent.session.id, turn.number, exec.callId]),
      beforeExecute: validate,
      signal: exec.signal,
    })) as JsonValue
  }

  async compatibility(
    name: string,
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<{ handled: boolean; value?: unknown }> {
    if (!names[name]) return { handled: false }
    const turn = this.current(exec)
    if (turn.held) return { handled: false }
    const operation = hash([exec.agent?.session.id, turn.number, exec.callId])
    return {
      handled: true,
      value: await this.call(names[name], contactArguments(name, args, operation), exec),
    }
  }

  close(): void {
    for (const dispose of this.dispose.splice(0).reverse()) dispose()
  }
}

export function contactArguments(
  name: string,
  args: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  const values = Object.fromEntries(Object.entries(args).map(([key, value]) => [snake(key), value]))
  if (name === 'inkbox_lookup_contact' && Object.values(values).filter(Boolean).length !== 1)
    throw new Error('Specify one contact lookup criterion')
  if (name === 'inkbox_delete_contact') return { ...values, idempotency_key: operation }
  if (name !== 'inkbox_create_contact' && name !== 'inkbox_update_contact') return values
  const { contact_id, ...fields } = values
  for (const key of ['emails', 'phones']) {
    const entries = fields[key]
    if (Array.isArray(entries))
      fields[key] = entries.map((entry) => {
        const value = entry as Record<string, unknown>
        return {
          [key === 'phones' ? 'value_e164' : 'value']: value.value,
          label: value.label ?? null,
          is_primary: value.isPrimary ?? false,
        }
      })
  }
  return {
    ...(name === 'inkbox_create_contact' ? { contact: fields } : { contact_id, patch: fields }),
    idempotency_key: operation,
  }
}
