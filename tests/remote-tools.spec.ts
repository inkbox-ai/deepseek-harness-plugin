import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { type Agent, agentEvents } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contactArguments, RemoteTools } from '../src/remote-tools.js'
import type { InkboxRuntime } from '../src/runtime.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function harness(incoming = false) {
  const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-remote-native-'))
  roots.push(stateDir)
  const ctx = new Context()
  ctx.provide('systemPrompt')
  ctx.set('systemPrompt', { tools: () => () => {} } as never)
  ctx.provide('approval')
  const approval = vi.fn(async () => 'allowed-once')
  ctx.set('approval', { request: approval } as never)
  const tools = new ToolRuntime(ctx)
  const signal = new AbortController()
  const agent = {
    id: SessionId('native-session'),
    session: { id: SessionId('native-session') },
    ctx,
  } as Agent
  const descriptors = [
    {
      name: 'inkbox_synthetic',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 2 } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      outputSchema: { type: 'object' },
      description: 'First',
    },
  ]
  const calls: Record<string, unknown>[] = []
  const accepted = {
    content: [{ type: 'text', text: 'Accepted' }],
    structuredContent: { id: 'receipt', destination: 'synthetic' },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body)
      const result =
        request.method === 'server/discover'
          ? { supportedVersions: ['2026-07-28'] }
          : request.method === 'tools/list'
            ? { tools: descriptors }
            : (calls.push(request.params),
              request.params.requestState
                ? accepted
                : { resultType: 'input_required', requestState: 'synthetic-state' })
      return Response.json({ jsonrpc: '2.0', id: request.id, result })
    }),
  )
  const client = {
    _apiKey: 'synthetic',
    _baseUrl: 'https://example.test',
    whoami: async () => ({ authSubtype: 'api_key.agent_scoped.claimed' }),
  }
  const runtime = {
    config: { stateDir, autoApproveInkboxTools: false },
    getClient: async () => client,
    getIdentity: async () => ({ id: 'synthetic-identity' }),
  } as unknown as InkboxRuntime
  const remote = new RemoteTools(ctx, runtime, () => incoming)
  remote.register()
  const prepare = (turn: number) =>
    agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { turn, step: 1, messages: [], signal: signal.signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
  const execute = (name: string, args: Record<string, unknown>, call = 'native-call') =>
    tools.execute({ name, arguments: args, agent, callId: CallId(call), signal: signal.signal })
  return { remote, descriptors, calls, accepted, approval, signal, prepare, execute, client }
}

describe('native remote tool relay', () => {
  it('preserves complete schemas/results and observes add/change/remove between turns', async () => {
    const h = await harness()
    await h.prepare(1)
    const listed = await h.execute('inkbox_remote_tools', {})
    expect(listed).toMatchObject({ isError: false, value: { tools: h.descriptors } })
    const result = await h.execute('inkbox_remote_call', {
      name: 'inkbox_synthetic',
      arguments: { text: 'Hello' },
    })
    expect(result).toMatchObject({ isError: false, value: h.accepted })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(h.accepted) }])
    expect(h.approval).toHaveBeenCalledOnce()
    await h.execute('inkbox_remote_call', { name: 'inkbox_synthetic', arguments: { text: 'Hello' } })
    expect(h.calls.map((call) => call.requestState)).toEqual([
      undefined,
      'synthetic-state',
      'synthetic-state',
    ])
    await h.execute(
      'inkbox_remote_call',
      { name: 'inkbox_synthetic', arguments: { text: 'Hello' } },
      'distinct-call',
    )
    expect(h.calls.slice(-2).map((call) => call.requestState)).toEqual([undefined, 'synthetic-state'])
    const submitted = h.calls.length
    expect(
      await h.execute(
        'inkbox_remote_call',
        { name: 'inkbox_synthetic', arguments: { text: 'x' } },
        'invalid-schema',
      ),
    ).toHaveProperty('isError', true)
    expect(h.calls).toHaveLength(submitted)
    h.descriptors[0]!.description = 'Changed'
    await h.prepare(2)
    expect(await h.execute('inkbox_remote_tools', {})).toMatchObject({
      value: { tools: [{ description: 'Changed' }] },
    })
    h.descriptors.push({ ...h.descriptors[0]!, name: 'inkbox_new' })
    await h.prepare(3)
    expect(await h.execute('inkbox_remote_tools', {})).toMatchObject({
      value: { tools: [{ name: 'inkbox_synthetic' }, { name: 'inkbox_new' }] },
    })
    h.descriptors.splice(0)
    await h.prepare(4)
    expect(await h.execute('inkbox_remote_tools', {})).toMatchObject({ value: { tools: [] } })
    expect(
      await h.execute('inkbox_remote_call', { name: 'inkbox_synthetic', arguments: { text: 'Hello' } }),
    ).toHaveProperty('isError', true)
    h.remote.close()
  })

  it('respects Ask denial, incoming ownership and cancellation', async () => {
    const h = await harness()
    await h.prepare(1)
    h.approval.mockResolvedValueOnce('denied')
    expect(
      await h.execute('inkbox_remote_call', { name: 'inkbox_synthetic', arguments: { text: 'Hello' } }),
    ).toHaveProperty('isError', true)
    expect(h.calls).toHaveLength(0)
    h.signal.abort()
    expect(
      await h.execute('inkbox_remote_call', { name: 'inkbox_synthetic', arguments: { text: 'Hello' } }),
    ).toHaveProperty('isError', true)
    h.remote.close()
    const incoming = await harness(true)
    await incoming.prepare(1)
    expect(
      await incoming.execute('inkbox_remote_call', {
        name: 'inkbox_synthetic',
        arguments: { text: 'Hello' },
      }),
    ).toHaveProperty('isError', false)
    expect(incoming.approval).not.toHaveBeenCalled()
    incoming.remote.close()
  })

  it('holds admin and unclaimed cohorts and rejects unknown authority', async () => {
    const h = await harness()
    for (const [index, authority] of [
      'api_key.admin_scoped',
      'api_key.agent_scoped.unclaimed',
      'unknown',
    ].entries()) {
      h.client.whoami = async () => ({ authSubtype: authority })
      await h.prepare(index + 1)
      expect(await h.execute('inkbox_remote_tools', {})).toHaveProperty('isError', true)
      expect(h.calls).toHaveLength(0)
    }
    h.remote.close()
  })

  it('keeps labeled contact fields and stable idempotency', () => {
    expect(
      contactArguments(
        'inkbox_update_contact',
        {
          contactId: 'contact',
          givenName: 'Example',
          phones: [{ value: '+15550000001', label: 'work', isPrimary: true }],
        },
        'operation',
      ),
    ).toEqual({
      contact_id: 'contact',
      patch: {
        given_name: 'Example',
        phones: [{ value_e164: '+15550000001', label: 'work', is_primary: true }],
      },
      idempotency_key: 'operation',
    })
  })
})
