import type { AgentIdentity } from '@inkbox/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  type OnboardingDependencies,
  reconcileSigningKey,
  resolveIdentityCredential,
  type SetupPrompts,
} from '../src/cli/onboarding.js'

function prompts(overrides: Partial<SetupPrompts> = {}): SetupPrompts {
  return {
    text: vi.fn(async (_label, fallback) => fallback ?? ''),
    secret: vi.fn(async () => ''),
    confirm: vi.fn(async (_label, fallback) => fallback ?? true),
    choose: vi.fn(async () => 0),
    ...overrides,
  }
}

function deps(createClient: (key: string) => unknown, overrides: Partial<OnboardingDependencies> = {}) {
  return {
    createClient,
    signup: vi.fn(),
    verifySignup: vi.fn(),
    resendSignupVerification: vi.fn(),
    ...overrides,
  } as unknown as OnboardingDependencies
}

describe('identity onboarding parity', () => {
  it('rejects unknown API-key subtypes before listing identities', async () => {
    const listIdentities = vi.fn()
    const client = {
      whoami: vi.fn(async () => ({ authType: 'api_key', authSubtype: 'api_key.future_scope' })),
      listIdentities,
    }
    await expect(
      resolveIdentityCredential(
        'ApiKey_test',
        undefined,
        prompts(),
        deps(() => client),
      ),
    ).rejects.toThrow('Unsupported Inkbox credential type')
    expect(listIdentities).not.toHaveBeenCalled()
  })

  it('lets an admin select an existing identity, mints an agent key, and retains transient authority', async () => {
    const selected = { id: 'identity-2', agentHandle: 'selected-agent' }
    const scopedIdentity = { ...selected, emailAddress: 'selected@example.test' }
    const createKey = vi.fn(async () => ({ apiKey: 'ApiKey_agent' }))
    const admin = {
      whoami: vi.fn(async () => ({ authType: 'api_key', authSubtype: 'api_key.admin_scoped' })),
      listIdentities: vi.fn(async () => [{ id: 'identity-1', agentHandle: 'first-agent' }, selected]),
      getIdentity: vi.fn(async (handle) => ({ ...selected, agentHandle: handle })),
      apiKeys: { create: createKey },
    }
    const scoped = { getIdentity: vi.fn(async () => scopedIdentity) }
    const prompt = prompts({ choose: vi.fn(async () => 1) })
    const result = await resolveIdentityCredential(
      'ApiKey_admin',
      undefined,
      prompt,
      deps((key) => (key === 'ApiKey_admin' ? admin : scoped)),
    )
    expect(createKey).toHaveBeenCalledWith({
      label: 'DeepSeek Harness - selected-agent',
      description: 'Agent-scoped credential for the DeepSeek Harness integration.',
      scopedIdentityId: 'identity-2',
    })
    expect(result).toMatchObject({ apiKey: 'ApiKey_agent', identity: scopedIdentity, authorityClient: admin })
  })

  it('lets an admin create a requested identity before downscoping', async () => {
    const created = { id: 'identity-new', agentHandle: 'new-agent' }
    const admin = {
      whoami: vi.fn(async () => ({ authType: 'api_key', authSubtype: 'api_key.admin_scoped' })),
      listIdentities: vi.fn(async () => []),
      createIdentity: vi.fn(async () => created),
      apiKeys: { create: vi.fn(async () => ({ apiKey: 'ApiKey_scoped' })) },
    }
    const scoped = { getIdentity: vi.fn(async () => created) }
    const result = await resolveIdentityCredential(
      'ApiKey_admin',
      'new-agent',
      prompts({ text: vi.fn(async (_label, fallback) => fallback ?? 'New Agent') }),
      deps((key) => (key === 'ApiKey_admin' ? admin : scoped)),
    )
    expect(admin.createIdentity).toHaveBeenCalledWith('new-agent', { displayName: 'New Agent' })
    expect(result.apiKey).toBe('ApiKey_scoped')
  })

  it('retries signup and requires resend after three failed verification codes', async () => {
    const answers = [
      'person@example.test',
      'deepseek-agent',
      'person@example.test',
      'deepseek-agent',
      '111111',
      '222222',
      '333333',
      'resend',
      '444444',
    ]
    const prompt = prompts({ text: vi.fn(async () => answers.shift() ?? '') })
    const signup = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary signup failure'))
      .mockResolvedValueOnce({
        apiKey: 'ApiKey_signup',
        humanEmail: 'person@example.test',
        agentHandle: 'deepseek-agent',
      })
    prompt.confirm = vi.fn(async () => true)
    const verifySignup = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad code'))
      .mockRejectedValueOnce(new Error('bad code'))
      .mockRejectedValueOnce(new Error('bad code'))
      .mockResolvedValueOnce({})
    const resendSignupVerification = vi.fn(async () => ({
      claimStatus: 'pending',
      organizationId: 'org-1',
      message: 'sent',
    })) as unknown as OnboardingDependencies['resendSignupVerification']
    const client = { getIdentity: vi.fn(async () => ({ id: 'identity-1', agentHandle: 'deepseek-agent' })) }
    const result = await resolveIdentityCredential(
      undefined,
      undefined,
      prompt,
      deps(() => client, { signup, verifySignup, resendSignupVerification }),
    )
    expect(signup).toHaveBeenCalledTimes(2)
    expect(verifySignup).toHaveBeenCalledTimes(4)
    expect(resendSignupVerification).toHaveBeenCalledWith('ApiKey_signup')
    expect(signup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        humanEmail: 'person@example.test',
        agentHandle: 'deepseek-agent',
        harness: 'deepseek-harness',
        noteToHuman: 'Setting up a DeepSeek Harness agent on Inkbox.',
      }),
    )
    expect(signup.mock.calls.at(-1)?.[0]).not.toHaveProperty('displayName')
    expect(result.apiKey).toBe('ApiKey_signup')
  })
})

describe('signing-key onboarding parity', () => {
  function identity(configured: boolean) {
    return {
      getSigningKeyStatus: vi.fn(async () => ({ configured })),
      createSigningKey: vi.fn(async () => ({ signingKey: 'whsec_new' })),
    } as unknown as AgentIdentity
  }

  it('creates a signing key when the remote identity has none, even if a stale local value exists', async () => {
    const value = identity(false)
    expect(await reconcileSigningKey(value, 'whsec_stale', undefined)).toBe('whsec_new')
    expect(value.createSigningKey).toHaveBeenCalledOnce()
  })

  it('reuses an available local key without rotating a configured remote key', async () => {
    const value = identity(true)
    expect(await reconcileSigningKey(value, 'whsec_existing', undefined)).toBe('whsec_existing')
    expect(value.createSigningKey).not.toHaveBeenCalled()
  })

  it('offers secure recovery and explicit rotation when the plaintext is unavailable', async () => {
    const value = identity(true)
    const recovered = await reconcileSigningKey(
      value,
      undefined,
      prompts({
        confirm: vi.fn(async () => true),
        secret: vi.fn(async () => 'whsec_recovered'),
      }),
    )
    expect(recovered).toBe('whsec_recovered')

    const rotated = await reconcileSigningKey(
      value,
      undefined,
      prompts({ confirm: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) }),
    )
    expect(rotated).toBe('whsec_new')
  })

  it('fails closed in non-interactive mode instead of silently rotating', async () => {
    await expect(reconcileSigningKey(identity(true), undefined, undefined)).rejects.toThrow(
      'unavailable locally',
    )
  })
})
