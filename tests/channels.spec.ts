import { type AgentIdentity, HostedAgentAuthorityMode, IncomingCallAction, type Inkbox } from '@inkbox/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  type ChannelDependencies,
  configureChannels,
  configureIMessage,
  configureVoice,
  waitForIMessageConnection,
  waitForSmsOptIn,
} from '../src/cli/channels.js'
import type { IdentityCredential, SetupPrompts } from '../src/cli/onboarding.js'

function prompts(overrides: Partial<SetupPrompts> = {}): SetupPrompts {
  return {
    text: vi.fn(async (_label, fallback) => fallback ?? ''),
    secret: vi.fn(async () => ''),
    confirm: vi.fn(async (_label, fallback) => fallback ?? true),
    choose: vi.fn(async () => 0),
    ...overrides,
  }
}

function dependencies(overrides: Partial<ChannelDependencies> = {}): ChannelDependencies {
  return {
    validateRealtimeKey: vi.fn(async () => ({ ok: true, detail: 'ready' })),
    createClient: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ChannelDependencies
}

function voiceIdentity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'identity-1',
    agentHandle: 'voice-agent',
    emailAddress: 'voice-agent@example.test',
    phoneNumber: { id: 'phone-1', number: '+15551234567' },
    tunnel: { publicHost: 'voice-agent.inkboxwire.com' },
    getHostedAgentConfig: vi.fn(async () => ({
      voice: 'old-voice',
      model: 'old-model',
      instructions: 'old instructions',
      authorityMode: HostedAgentAuthorityMode.CONTACT_SCOPED,
    })),
    setHostedAgentConfig: vi.fn(async (value) => value),
    getIncomingCallAction: vi.fn(async () => ({
      incomingCallAction: IncomingCallAction.AUTO_REJECT,
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
      forwardingTargetType: null,
      forwardingPhoneNumber: null,
      forwardingSipUri: null,
    })),
    setIncomingCallAction: vi.fn(async (value) => value),
    ...overrides,
  } as unknown as AgentIdentity
}

function credential(identity: AgentIdentity, authorityClient?: unknown): IdentityCredential {
  return {
    apiKey: 'ApiKey_agent',
    identity,
    client: {} as Inkbox,
    ...(authorityClient ? { authorityClient: authorityClient as Inkbox } : {}),
  }
}

describe('phone-call stack onboarding parity', () => {
  it('offers phone-call handling for an iMessage-only identity', async () => {
    const identity = voiceIdentity({
      phoneNumber: null,
      imessageEnabled: true,
      listIMessageAssignments: vi.fn(async () => [{ remoteNumber: '+15550000001' }]),
      a2aSettings: vi.fn(async () => ({ enabled: false })),
    })
    const client = { getIdentity: vi.fn(async () => identity) } as unknown as Inkbox
    const prompt = prompts({
      confirm: vi.fn(async (_label, fallback) => fallback ?? false),
      text: vi.fn(async () => ''),
    })
    const result = await configureChannels(
      { ...credential(identity), client },
      prompt,
      { provisionPhone: false },
      dependencies(),
    )
    expect(result.voiceStack).toBe('inkbox_voice_ai')
    expect(prompt.text).not.toHaveBeenCalledWith('Press Enter to continue and set up phone call handling')
    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: IncomingCallAction.HOSTED_AGENT,
    })
  })

  it('offers only hosted agent and OpenAI Realtime, validates the key, and saves raw-media routing', async () => {
    const identity = voiceIdentity()
    const prompt = prompts({ choose: vi.fn(async () => 1), secret: vi.fn(async () => 'sk-realtime') })
    const deps = dependencies()
    const result = await configureVoice(identity, credential(identity), prompt, {}, deps)
    expect(prompt.choose).toHaveBeenCalledWith(
      'Choose phone-call handling:',
      ['Inkbox hosted agent', 'OpenAI Realtime API'],
      0,
    )
    expect(deps.validateRealtimeKey).toHaveBeenCalledWith('sk-realtime', 'gpt-realtime-2')
    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: IncomingCallAction.AUTO_ACCEPT,
      clientWebsocketUrl: 'wss://voice-agent.inkboxwire.com/phone/media/ws',
    })
    expect(result).toEqual({
      voiceStack: 'openai_realtime',
      realtimeApiKey: 'sk-realtime',
      realtimeModel: 'gpt-realtime-2',
      realtimeVoice: 'cedar',
    })
  })

  it('defaults a rerun to the previously saved Realtime selection', async () => {
    const identity = voiceIdentity()
    const prompt = prompts({ choose: vi.fn(async () => 1), secret: vi.fn(async () => 'sk-realtime') })
    await configureVoice(
      identity,
      credential(identity),
      prompt,
      { voiceDefault: 'openai_realtime' },
      dependencies(),
    )
    expect(prompt.choose).toHaveBeenCalledWith(
      'Choose phone-call handling:',
      ['Inkbox hosted agent', 'OpenAI Realtime API'],
      1,
    )
  })

  it('does not partially save an invalid Realtime choice and returns to the two stack choices', async () => {
    const identity = voiceIdentity()
    const choose = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(0)
    const result = await configureVoice(
      identity,
      credential(identity),
      prompts({ choose, secret: vi.fn(async () => 'sk-invalid') }),
      {},
      dependencies({ validateRealtimeKey: vi.fn(async () => ({ ok: false, detail: 'not authorized' })) }),
    )
    expect(result.voiceStack).toBe('inkbox_voice_ai')
    expect(identity.setIncomingCallAction).toHaveBeenCalledTimes(1)
    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: IncomingCallAction.HOSTED_AGENT,
    })
  })

  it('configures hosted-agent contact scope without retaining an admin credential', async () => {
    const identity = voiceIdentity()
    const result = await configureVoice(
      identity,
      credential(identity),
      undefined,
      { voiceStack: 'inkbox_voice_ai', hostedAuthority: 'contact_scoped' },
      dependencies(),
    )
    expect(identity.setHostedAgentConfig).toHaveBeenCalledWith({})
    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: IncomingCallAction.HOSTED_AGENT,
    })
    expect(result).toEqual({ voiceStack: 'inkbox_voice_ai' })
  })

  it('stores the call instruction in hosted-agent configuration', async () => {
    const identity = voiceIdentity()
    await configureVoice(
      identity,
      credential(identity),
      undefined,
      {
        voiceStack: 'inkbox_voice_ai',
        hostedAuthority: 'contact_scoped',
        callInstruction: 'Speak in short, natural sentences.',
      },
      dependencies(),
    )
    expect(identity.setHostedAgentConfig).toHaveBeenCalledWith({
      instructions: 'Speak in short, natural sentences.',
    })
  })

  it('uses transient admin authority for YOLO mode', async () => {
    const identity = voiceIdentity()
    const authorityIdentity = {
      setHostedAgentAuthorityMode: vi.fn(async () => ({})),
    }
    const authorityClient = { getIdentity: vi.fn(async () => authorityIdentity) }
    await configureVoice(
      identity,
      credential(identity, authorityClient),
      undefined,
      { voiceStack: 'inkbox_voice_ai', hostedAuthority: 'yolo' },
      dependencies(),
    )
    expect(authorityIdentity.setHostedAgentAuthorityMode).toHaveBeenCalledWith({
      authorityMode: HostedAgentAuthorityMode.YOLO,
    })
  })

  it('prompts for transient admin authority when downscoping an existing YOLO identity', async () => {
    const identity = voiceIdentity({
      getHostedAgentConfig: vi.fn(async () => ({
        voice: null,
        model: null,
        instructions: null,
        authorityMode: HostedAgentAuthorityMode.YOLO,
      })),
    })
    const authorityIdentity = { setHostedAgentAuthorityMode: vi.fn(async () => ({})) }
    const adminClient = {
      whoami: vi.fn(async () => ({ authType: 'api_key', authSubtype: 'api_key.admin_scoped' })),
      getIdentity: vi.fn(async () => authorityIdentity),
    }
    await configureVoice(
      identity,
      credential(identity),
      prompts({ secret: vi.fn(async () => 'ApiKey_admin') }),
      { voiceStack: 'inkbox_voice_ai', hostedAuthority: 'contact_scoped' },
      dependencies({ createClient: vi.fn(() => adminClient as unknown as Inkbox) }),
    )
    expect(authorityIdentity.setHostedAgentAuthorityMode).toHaveBeenCalledWith({
      authorityMode: HostedAgentAuthorityMode.CONTACT_SCOPED,
    })
  })

  it('restores hosted and incoming-call configuration after a partial failure', async () => {
    const setIncomingCallAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('remote update failed'))
      .mockResolvedValueOnce({})
    const identity = voiceIdentity({ setIncomingCallAction })
    await expect(
      configureVoice(
        identity,
        credential(identity),
        undefined,
        { voiceStack: 'inkbox_voice_ai', hostedAuthority: 'contact_scoped' },
        dependencies(),
      ),
    ).rejects.toThrow('remote update failed')
    expect(identity.setHostedAgentConfig).toHaveBeenNthCalledWith(1, {})
    expect(identity.setHostedAgentConfig).toHaveBeenNthCalledWith(2, {
      voice: 'old-voice',
      model: 'old-model',
      instructions: 'old instructions',
    })
    expect(setIncomingCallAction).toHaveBeenNthCalledWith(2, {
      incomingCallAction: IncomingCallAction.AUTO_REJECT,
    })
  })
})

describe('iMessage and phone onboarding parity', () => {
  it('does not add an interactive A2A question', async () => {
    const identity = {
      agentHandle: 'deepseek-agent',
      imessageEnabled: false,
      phoneNumber: null,
      a2aSettings: vi.fn(async () => ({ enabled: false })),
    } as unknown as AgentIdentity
    const client = { getIdentity: vi.fn(async () => identity) } as unknown as Inkbox
    const confirm = vi.fn(async () => false)
    await configureChannels(
      { apiKey: 'ApiKey_agent', client, identity },
      prompts({ confirm }),
      {},
      dependencies(),
    )
    expect(confirm.mock.calls.flat().join(' ')).not.toMatch(/agent-to-agent/i)
  })

  it('waits for an inbound START after provisioning', async () => {
    const listTexts = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ direction: 'inbound', text: 'START', remotePhoneNumber: '+15550000001' }])
    const identity = {
      phoneNumber: { number: '+15550000002' },
      listTexts,
    } as unknown as AgentIdentity
    const deps = dependencies()
    await waitForSmsOptIn(identity, deps, 2)
    expect(deps.sleep).toHaveBeenCalledWith(3_000)
    expect(listTexts).toHaveBeenCalledTimes(2)
  })

  it('defaults to leaving an existing iMessage connection untouched', async () => {
    const identity = {
      imessageEnabled: true,
      listIMessageAssignments: vi.fn(async () => [{ remoteNumber: '+15550000001' }]),
      update: vi.fn(),
    } as unknown as AgentIdentity
    const prompt = prompts()
    expect(await configureIMessage(identity, {} as Inkbox, prompt, {}, dependencies())).toBe(true)
    expect(prompt.confirm).toHaveBeenCalledWith('Connect another iPhone to this agent now?', false)
    expect(identity.update).not.toHaveBeenCalled()
  })

  it('enables iMessage, waits for the first inbound message, and sends a welcome', async () => {
    const update = vi.fn(async () => ({}))
    const sendIMessage = vi.fn(async () => ({}))
    const listIMessageAssignments = vi.fn(async () => [])
    const listIMessages = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { direction: 'inbound', conversationId: 'conversation-1', remoteNumber: '+15550000001' },
      ])
    const markIMessageConversationRead = vi.fn(async () => ({}))
    const identity = {
      agentHandle: 'deepseek-agent',
      imessageEnabled: false,
      update,
      listIMessageAssignments,
      listIMessages,
      sendIMessage,
      markIMessageConversationRead,
    } as unknown as AgentIdentity
    const client = {
      imessages: {
        getTriageNumber: vi.fn(async () => ({ number: '+15550000002', connectCommand: 'CONNECT ABC' })),
      },
    } as unknown as Inkbox
    const deps = dependencies()
    const prompt = prompts()
    expect(await configureIMessage(identity, client, prompt, {}, deps)).toBe(true)
    expect(prompt.confirm).toHaveBeenNthCalledWith(
      1,
      'Enable iMessage (RCS/SMS fallback and voice calls) for this agent?',
      true,
    )
    expect(update).toHaveBeenCalledWith({ imessageEnabled: true })
    expect(deps.sleep).toHaveBeenCalledWith(3_000)
    expect(sendIMessage).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      text: expect.stringContaining('DeepSeek agent @deepseek-agent'),
    })
    expect(markIMessageConversationRead).toHaveBeenCalledWith('conversation-1')
  })

  it('times out iMessage waiting without failing the rest of setup', async () => {
    const identity = {
      listIMessages: vi.fn(async () => []),
    } as unknown as AgentIdentity
    await expect(waitForIMessageConnection(identity, dependencies(), 2)).resolves.toBeUndefined()
    expect(identity.listIMessages).toHaveBeenCalledTimes(2)
  })

  it('continues setup when optional phone provisioning fails', async () => {
    const identity = {
      agentHandle: 'deepseek-agent',
      imessageEnabled: false,
      phoneNumber: null,
      a2aSettings: vi.fn(async () => ({ enabled: false })),
      provisionPhoneNumber: vi.fn(async () => {
        throw new Error('inventory pending')
      }),
    } as unknown as AgentIdentity
    const client = { getIdentity: vi.fn(async () => identity) } as unknown as Inkbox
    const result = await configureChannels(
      { apiKey: 'ApiKey_agent', client, identity },
      undefined,
      {
        nonInteractive: true,
        enableIMessage: false,
        enableA2A: false,
        provisionPhone: true,
        phoneState: 'NY',
      },
      dependencies(),
    )
    expect(result.phoneProvisioned).toBe(false)
    expect(result.identity).toBe(identity)
  })
})
