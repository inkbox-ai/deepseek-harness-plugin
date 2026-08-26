import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { InkboxRuntime } from '../src/runtime.js'
import { registerTools } from '../src/tools.js'

function harness() {
  const definitions: ToolDefinition[] = []
  const request = vi.fn(async () => 'allowed-once')
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        definitions.push(definition)
      },
    },
    approval: { request },
  } as unknown as Context
  const identity = {
    id: 'identity-1',
    agentHandle: 'agent',
    displayName: 'Agent',
    emailAddress: 'agent@example.test',
    phoneNumber: null,
    imessageEnabled: true,
    imessageNumber: null,
    tunnel: { id: 'tunnel' },
    sendEmail: vi.fn(async () => ({ id: 'mail-1' })),
    sendIMessage: vi.fn(async () => ({ id: 'imessage-1' })),
  }
  const client = { whoami: vi.fn(async () => ({ authType: 'api_key' })) }
  const runtime = {
    getClient: vi.fn(async () => client),
    getIdentity: vi.fn(async () => identity),
  } as unknown as InkboxRuntime
  registerTools(ctx, runtime)
  return { definitions, request, identity, client, runtime }
}

function findTool(definitions: ToolDefinition[], name: string): ToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name)
  if (definition === undefined) throw new Error(`Missing tool ${name}`)
  return definition
}

const exec = {
  agent: { session: {} },
  callId: 'call-1',
  signal: new AbortController().signal,
} as unknown as ToolRunContext

describe('Harness tool registration and execution', () => {
  it('registers all tools with canonical output renderers', () => {
    const { definitions } = harness()
    expect(definitions).toHaveLength(33)
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(33)
    expect(definitions.every((definition) => definition.output?.schema?.type === 'string')).toBe(true)
  })

  it('executes a read without prompting for approval', async () => {
    const { definitions, request, client } = harness()
    const tool = findTool(definitions, 'inkbox_whoami')
    const result = JSON.parse(String(await tool.execute({}, exec)))
    expect(result.identity.agentHandle).toBe('agent')
    expect(client.whoami).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
  })

  it('requires Harness approval before outbound email', async () => {
    const { definitions, request, identity } = harness()
    const tool = findTool(definitions, 'inkbox_send_email')
    await tool.execute({ to: ['person@example.test'], subject: 'Hello', bodyText: 'Body' }, exec)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'inkbox_send_email', agent: exec.agent }),
    )
    expect(identity.sendEmail).toHaveBeenCalledOnce()
  })

  it('converts explicit iMessage tool sends to plain text', async () => {
    const { definitions, identity } = harness()
    const tool = findTool(definitions, 'inkbox_send_imessage')
    await tool.execute({ conversationId: 'conversation-1', text: '**Done**\n- First item' }, exec)
    expect(identity.sendIMessage).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      text: 'Done\nFirst item',
    })
  })

  it('fails closed when outbound approval is rejected', async () => {
    const { definitions, request, identity } = harness()
    request.mockResolvedValueOnce('rejected')
    const tool = findTool(definitions, 'inkbox_send_email')
    await expect(tool.execute({ to: ['person@example.test'], subject: 'Hello' }, exec)).rejects.toThrow(
      /not approved/,
    )
    expect(identity.sendEmail).not.toHaveBeenCalled()
  })

  it('does not enter the SDK after caller cancellation', async () => {
    const { definitions, runtime } = harness()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const tool = findTool(definitions, 'inkbox_whoami')
    await expect(tool.execute({}, { ...exec, signal: controller.signal })).rejects.toThrow('cancelled')
    expect(runtime.getClient).not.toHaveBeenCalled()
  })

  it('marks read-only tools concurrency-safe but keeps writes exclusive', () => {
    const { definitions } = harness()
    const read = findTool(definitions, 'inkbox_list_contacts')
    expect(read.isConcurrencySafe?.({})).toBe(true)
    expect(findTool(definitions, 'inkbox_send_sms').isConcurrencySafe).toBeUndefined()
  })
})
