import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { SLACK_TOOL_NAMES } from '../src/constants.js'
import type { InkboxRuntime } from '../src/runtime.js'
import { registerTools } from '../src/tools.js'

function harness(autoApproveInkboxTools = false) {
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
    config: { autoApproveInkboxTools },
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
    expect(definitions).toHaveLength(38)
    expect(new Set(definitions.map((definition) => definition.name)).size).toBe(38)
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

  it('skips approval only when the profile trusts Inkbox tools', async () => {
    const { definitions, request, identity } = harness(true)
    const tool = findTool(definitions, 'inkbox_send_email')
    await tool.execute({ to: ['person@example.test'], subject: 'Hello', bodyText: 'Body' }, exec)
    expect(request).not.toHaveBeenCalled()
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

describe('Vault credential tools', () => {
  const SECRET = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff'
  const OTHER = '7a9619ff-8b86-4d01-b42d-00cf4fc964ff'

  function vaultHarness(vaultKey: string | undefined, autoApproveInkboxTools = true) {
    const definitions: ToolDefinition[] = []
    const request = vi.fn(async () => 'allowed-once')
    const ctx = {
      tools: { register: (definition: ToolDefinition) => definitions.push(definition) },
      approval: { request },
    } as unknown as Context
    const shared = [{ identityId: 'identity-1' }]
    const unlocked = {
      getSecret: vi.fn(async (id: string) =>
        id === SECRET
          ? {
              id,
              secretType: 'login',
              payload: { username: 'agent', password: 'pw', totp: { secret: 'seed' } },
            }
          : { id, secretType: 'api_key', payload: { apiKey: 'key' } },
      ),
      getTotpCode: vi.fn(async () => ({ code: '123456', secondsRemaining: 20 })),
    }
    const vault = {
      listSecrets: vi.fn(async () => [
        { id: SECRET, name: 'Mail', secretType: 'login', description: null, access: shared },
        { id: OTHER, name: 'Hidden', secretType: 'api_key', description: null, access: [] },
      ]),
      listAccessRules: vi.fn(async (id: string) => (id === SECRET ? shared : [])),
      unlock: vi.fn(async () => {
        vault._unlocked = unlocked
        return unlocked
      }),
      _unlocked: null as unknown,
    }
    const runtime = {
      config: { autoApproveInkboxTools, slackEnabled: false },
      getClient: vi.fn(async () => ({ vault })),
      getIdentity: vi.fn(async () => ({ id: 'identity-1' })),
      resolveVaultKey: vi.fn(async () => vaultKey),
    } as unknown as InkboxRuntime
    registerTools(ctx, runtime)
    const run = (name: string, args: Record<string, unknown>) =>
      findTool(definitions, name).execute(args, exec)
    return { run, request, vault, unlocked }
  }

  it('lists only metadata shared with this identity without unlocking', async () => {
    const { run, vault } = vaultHarness(undefined)
    expect(JSON.parse(String(await run('inkbox_credentials_list', { type: 'login' })))).toEqual([
      { id: SECRET, name: 'Mail', secretType: 'login', description: null },
    ])
    expect(vault.listSecrets).toHaveBeenCalledWith({ secretType: 'login' })
    expect(vault.unlock).not.toHaveBeenCalled()
  })

  it('explains both unlock-key paths when the Vault is locked', async () => {
    const { run, vault } = vaultHarness(undefined)
    await expect(run('inkbox_credentials_get_login', { secretId: SECRET })).rejects.toThrow(
      /INKBOX_DEEPSEEK_VAULT_KEY.*Env vars tab.*export it/,
    )
    expect(vault.unlock).not.toHaveBeenCalled()
  })

  it('unlocks with the plugin key and omits the TOTP seed from a login', async () => {
    const { run, vault } = vaultHarness('vault-key')
    const login = JSON.parse(String(await run('inkbox_credentials_get_login', { secretId: SECRET })))
    expect(login).toEqual({ username: 'agent', password: 'pw', has_totp: true })
    expect(vault.listAccessRules).toHaveBeenCalledTimes(2)
    expect(vault.unlock).toHaveBeenCalledWith('vault-key')
    expect(vault._unlocked).toBeNull()
  })

  it('withholds a credential whose sharing is revoked during the read', async () => {
    const { run, vault, unlocked } = vaultHarness('vault-key')
    vault.listAccessRules.mockResolvedValueOnce([{ identityId: 'identity-1' }]).mockResolvedValueOnce([])
    await expect(run('inkbox_credentials_get_login', { secretId: SECRET })).rejects.toThrow(/not shared/)
    expect(unlocked.getSecret).toHaveBeenCalledWith(SECRET)
    expect(vault._unlocked).toBeNull()
  })

  it('returns a current TOTP code', async () => {
    const { run, unlocked } = vaultHarness('vault-key')
    expect(JSON.parse(String(await run('inkbox_totp_code', { secretId: SECRET })))).toEqual({
      code: '123456',
      secondsRemaining: 20,
    })
    expect(unlocked.getTotpCode).toHaveBeenCalledWith(SECRET)
  })

  it('refuses unshared, mistyped and malformed secret IDs', async () => {
    const { run, vault } = vaultHarness('vault-key')
    await expect(run('inkbox_credentials_get_api_key', { secretId: OTHER })).rejects.toThrow(/not shared/)
    expect(vault.unlock).not.toHaveBeenCalled()
    await expect(run('inkbox_credentials_get_ssh_key', { secretId: SECRET })).rejects.toThrow(
      /not a ssh_key secret/,
    )
    vault.listAccessRules.mockClear()
    await expect(run('inkbox_credentials_get_login', { secretId: '../keys' })).rejects.toThrow(/UUID/)
    expect(vault.listAccessRules).not.toHaveBeenCalled()
  })

  it('rejects a malformed secret ID before asking for approval', async () => {
    const { run, request } = vaultHarness('vault-key', false)
    await expect(run('inkbox_totp_code', { secretId: 'see the attached key' })).rejects.toThrow(/UUID/)
    expect(request).not.toHaveBeenCalled()
  })

  it('asks for approval before a plaintext read unless Inkbox tools are trusted', async () => {
    const { run, request } = vaultHarness('vault-key', false)
    await run('inkbox_credentials_list', {})
    expect(request).not.toHaveBeenCalled()
    await run('inkbox_credentials_get_login', { secretId: SECRET })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'inkbox_credentials_get_login' }),
    )
  })
})

describe('Slack tools', () => {
  function slackHarness(slackEnabled: boolean) {
    const definitions: ToolDefinition[] = []
    const request = vi.fn(async () => 'allowed-once')
    const ctx = {
      tools: { register: (definition: ToolDefinition) => definitions.push(definition) },
      approval: { request },
    } as unknown as Context
    const slack = {
      listConnections: vi.fn(async () => ({
        connections: [
          { id: 'connection-1', identityId: 'identity-1', workspaceId: 'T1', status: 'connected' },
        ],
      })),
      listMessages: vi.fn(async () => ({ messages: [], nextCursor: null, hasMore: false })),
      sendMessage: vi.fn(async () => ({ id: 'action-1', status: 'sent' })),
    }
    const runtime = {
      config: { autoApproveInkboxTools: false, slackEnabled },
      getClient: vi.fn(async () => ({ slack })),
      getIdentity: vi.fn(async () => ({ id: 'identity-1' })),
    } as unknown as InkboxRuntime
    registerTools(ctx, runtime)
    return { definitions, request, slack }
  }

  it('registers the Slack tools only when Slack is enabled', () => {
    expect(slackHarness(false).definitions.some((tool) => tool.name.startsWith('inkbox_slack_'))).toBe(false)
    const names = slackHarness(true).definitions.map((tool) => tool.name)
    expect(names.filter((name) => name.startsWith('inkbox_slack_'))).toEqual([...SLACK_TOOL_NAMES])
    expect(names).toHaveLength(38 + SLACK_TOOL_NAMES.length)
  })

  it('reads Slack history on an owned connection without approval', async () => {
    const { definitions, request, slack } = slackHarness(true)
    await findTool(definitions, 'inkbox_slack_list_messages').execute(
      { connectionId: 'connection-1', conversationId: 'C1', threadTs: '1770000000.000100', limit: 20 },
      exec,
    )
    expect(slack.listMessages).toHaveBeenCalledWith('connection-1', 'C1', {
      threadTs: '1770000000.000100',
      limit: 20,
    })
    expect(request).not.toHaveBeenCalled()
    await expect(
      findTool(definitions, 'inkbox_slack_list_messages').execute(
        { connectionId: 'connection-2', conversationId: 'C1' },
        exec,
      ),
    ).rejects.toThrow(/not connected to this identity/)
  })

  it('requires approval and a stable key before sending a Slack message', async () => {
    const { definitions, request, slack } = slackHarness(true)
    const tool = findTool(definitions, 'inkbox_slack_send_message')
    await expect(
      tool.execute(
        { connectionId: 'connection-1', conversationId: 'C1', text: 'Hi', idempotencyKey: 'bad key' },
        exec,
      ),
    ).rejects.toThrow(/idempotencyKey/)
    await tool.execute(
      { connectionId: 'connection-1', conversationId: 'C1', text: '**Done**', idempotencyKey: 'send-1' },
      exec,
    )
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'inkbox_slack_send_message' }))
    expect(slack.sendMessage).toHaveBeenCalledWith('connection-1', {
      conversationId: 'C1',
      text: '*Done*',
      idempotencyKey: 'send-1',
    })
  })

  it.each([
    ['inkbox_slack_list_messages', { connectionId: 'connection-1', conversationId: 'C1', limit: 0 }],
    ['inkbox_slack_list_conversations', { connectionId: 'connection-1', limit: 101 }],
    ['inkbox_slack_list_messages', { connectionId: 'connection-1', conversationId: '' }],
    ['inkbox_slack_list_messages', { connectionId: 'connection-1', conversationId: 'C1', reaction: 'eyes' }],
    [
      'inkbox_slack_send_message',
      { connectionId: 'connection-1', conversationId: 'C1', text: 'Hi', idempotencyKey: 'bad key' },
    ],
    [
      'inkbox_slack_send_message',
      {
        connectionId: 'connection-1',
        conversationId: 'C1',
        text: 'x'.repeat(12_001),
        idempotencyKey: 'send-1',
      },
    ],
    [
      'inkbox_slack_send_message',
      { connectionId: 'connection-1', conversationId: 'C1', idempotencyKey: 'send-1' },
    ],
  ])('rejects invalid %s arguments before approval or any API call', async (name, args) => {
    const { definitions, request, slack } = slackHarness(true)
    await expect(findTool(definitions, name).execute(args, exec)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    expect(slack.listConnections).not.toHaveBeenCalled()
    expect(slack.listMessages).not.toHaveBeenCalled()
    expect(slack.sendMessage).not.toHaveBeenCalled()
  })
})
