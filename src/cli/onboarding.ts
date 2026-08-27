import {
  type AgentIdentity,
  AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED,
  Inkbox,
} from '@inkbox/sdk'

export interface SetupPrompts {
  text(label: string, defaultValue?: string): Promise<string>
  secret(label: string): Promise<string>
  confirm(label: string, defaultValue?: boolean): Promise<boolean>
  choose(label: string, choices: readonly string[], defaultIndex?: number): Promise<number>
}

export interface OnboardingDependencies {
  createClient(apiKey: string): Inkbox
  signup(request: Parameters<typeof Inkbox.signup>[0]): ReturnType<typeof Inkbox.signup>
  verifySignup(
    apiKey: string,
    request: Parameters<typeof Inkbox.verifySignup>[1],
  ): ReturnType<typeof Inkbox.verifySignup>
  resendSignupVerification(apiKey: string): ReturnType<typeof Inkbox.resendSignupVerification>
}

export const defaultOnboardingDependencies: OnboardingDependencies = {
  createClient: (apiKey) => new Inkbox({ apiKey }),
  signup: (request) => Inkbox.signup(request),
  verifySignup: (apiKey, request) => Inkbox.verifySignup(apiKey, request),
  resendSignupVerification: (apiKey) => Inkbox.resendSignupVerification(apiKey),
}

export interface IdentityCredential {
  apiKey: string
  client: Inkbox
  identity: AgentIdentity
  authorityClient?: Inkbox
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function promptIdentityDetails(prompts: SetupPrompts, preferredHandle?: string) {
  let humanEmail = ''
  while (!humanEmail.includes('@')) humanEmail = await prompts.text('Your email address')
  let agentHandle = ''
  while (!agentHandle.trim())
    agentHandle = await prompts.text('Agent handle', preferredHandle ?? 'deepseek-agent')
  return {
    humanEmail,
    agentHandle,
  }
}

async function selfSignup(
  prompts: SetupPrompts,
  dependencies: OnboardingDependencies,
): Promise<IdentityCredential> {
  let response: Awaited<ReturnType<typeof Inkbox.signup>> | undefined
  while (response === undefined) {
    const details = await promptIdentityDetails(prompts)
    try {
      response = await dependencies.signup({
        ...details,
        noteToHuman: 'Setting up a DeepSeek Harness agent on Inkbox.',
        harness: 'deepseek-harness',
      })
    } catch (error) {
      process.stderr.write(`Identity signup failed: ${message(error)}\n`)
      const status = (error as { statusCode?: number }).statusCode
      const detail = message(error).toLowerCase()
      const retryLabel =
        status === 429 && detail.includes('unclaimed agents')
          ? 'Try a different email'
          : status === 409 ||
              (status === 422 && (detail.includes('handle') || detail.includes('unavailable')))
            ? 'Pick a different handle'
            : 'Re-enter all details and try again'
      const choice = await prompts.choose('What now?', [
        retryLabel,
        'Abort — keep existing Inkbox configuration unchanged',
      ])
      if (choice !== 0) throw error
    }
  }

  process.stdout.write(`Verification was sent to ${response.humanEmail}.\n`)
  let failedAttempts = 0
  while (true) {
    const code = await prompts.text(
      failedAttempts >= 3 ? "Type 'resend' for a new verification code" : 'Six-digit verification code',
    )
    if (code.toLowerCase() === 'resend') {
      await dependencies.resendSignupVerification(response.apiKey)
      failedAttempts = 0
      process.stdout.write('A new verification code was sent.\n')
      continue
    }
    if (failedAttempts >= 3) {
      process.stderr.write("This verification code can no longer be retried. Type 'resend'.\n")
      continue
    }
    try {
      await dependencies.verifySignup(response.apiKey, { verificationCode: code })
      break
    } catch (error) {
      failedAttempts += 1
      process.stderr.write(`Verification failed (${failedAttempts}/3): ${message(error)}\n`)
    }
  }

  const client = dependencies.createClient(response.apiKey)
  return {
    apiKey: response.apiKey,
    client,
    identity: await client.getIdentity(response.agentHandle),
  }
}

async function createIdentity(client: Inkbox, prompts: SetupPrompts, preferredHandle?: string) {
  let handle = preferredHandle ?? ''
  while (true) {
    if (!handle) handle = await prompts.text('Agent handle (globally unique; also the mailbox local part)')
    const displayName = await prompts.text('Display name for recipients (optional)')
    try {
      return await client.createIdentity(handle, { ...(displayName ? { displayName } : {}) })
    } catch (error) {
      process.stderr.write(`Identity creation failed: ${message(error)}\n`)
      if (!(await prompts.confirm('Choose another handle?', true))) throw error
      handle = ''
    }
  }
}

export async function resolveIdentityCredential(
  apiKey: string | undefined,
  requested: string | undefined,
  prompts: SetupPrompts | undefined,
  dependencies: OnboardingDependencies = defaultOnboardingDependencies,
): Promise<IdentityCredential> {
  if (!apiKey) {
    if (prompts === undefined) throw new Error('INKBOX_API_KEY is required for non-interactive setup')
    return selfSignup(prompts, dependencies)
  }

  const client = dependencies.createClient(apiKey)
  const whoami = await client.whoami()
  if (
    whoami.authType !== 'api_key' ||
    ![
      AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED,
      AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED,
      AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED,
    ].includes(whoami.authSubtype ?? '')
  ) {
    throw new Error(`Unsupported Inkbox credential type: ${whoami.authSubtype ?? whoami.authType}`)
  }
  const isAdmin = whoami.authSubtype === AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED
  const identities = await client.listIdentities()
  let selected = requested ? identities.find((identity) => identity.agentHandle === requested) : undefined

  if (selected === undefined && requested && !isAdmin)
    throw new Error(`This credential cannot access the requested identity ${requested}`)
  if (selected === undefined && identities.length === 1 && !requested) selected = identities[0]

  let identity: AgentIdentity
  if (selected !== undefined) {
    identity = await client.getIdentity(selected.agentHandle)
  } else if (isAdmin && prompts !== undefined) {
    const details = await Promise.all(
      identities.map((candidate) => client.getIdentity(candidate.agentHandle).catch(() => undefined)),
    )
    const choices = [
      ...identities.map((candidate, index) => {
        const detail = details[index]
        return `${candidate.agentHandle} — ${detail?.emailAddress ?? candidate.emailAddress ?? 'no mailbox'} — ${detail?.phoneNumber?.number ?? 'no phone'}`
      }),
      'Create a new identity',
    ]
    const index = requested
      ? choices.length - 1
      : await prompts.choose('Select the identity this DeepSeek gateway should run as:', choices)
    identity =
      index === identities.length
        ? await createIdentity(client, prompts, requested)
        : (details[index] ?? (await client.getIdentity(identities[index]?.agentHandle ?? '')))
  } else if (identities.length === 0) {
    throw new Error('This credential cannot access an Inkbox identity')
  } else {
    throw new Error('Select an identity with --identity')
  }

  if (!isAdmin) return { apiKey, client, identity }

  const scoped = await client.apiKeys.create({
    label: `DeepSeek Harness - ${identity.agentHandle}`,
    description: 'Agent-scoped credential for the DeepSeek Harness integration.',
    scopedIdentityId: identity.id,
  })
  const scopedClient = dependencies.createClient(scoped.apiKey)
  return {
    apiKey: scoped.apiKey,
    client: scopedClient,
    identity: await scopedClient.getIdentity(identity.agentHandle),
    authorityClient: client,
  }
}

export async function reconcileSigningKey(
  identity: AgentIdentity,
  localKey: string | undefined,
  prompts: SetupPrompts | undefined,
  rotate = false,
): Promise<string> {
  const status = await identity.getSigningKeyStatus()
  if (prompts === undefined) {
    if (!status.configured || rotate) return (await identity.createSigningKey()).signingKey
    if (localKey) return localKey
    throw new Error(
      'A signing key already exists for this identity but is unavailable locally. Supply INKBOX_WEBHOOK_SIGNING_KEY or rerun with explicit rotation.',
    )
  }

  process.stdout.write('\nWebhook signing key\n')
  process.stdout.write('Inkbox signs outbound webhooks so the gateway can verify inbound traffic.\n')
  if (!rotate && (await prompts.confirm('Do you already have an Inkbox signing key?', false))) {
    const supplied = await prompts.secret('Paste your Inkbox signing key')
    if (supplied) return supplied
    process.stderr.write('No key entered; a signing key is required, so a new one must be generated.\n')
  }
  process.stdout.write('Generating a new key rotates any existing key for this identity.\n')
  if (!(await prompts.confirm('Generate a new signing key now?', true)))
    throw new Error('A signing key is required; setup cannot continue without one')
  return (await identity.createSigningKey()).signingKey
}
