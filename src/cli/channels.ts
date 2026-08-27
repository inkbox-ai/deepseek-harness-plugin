import { type AgentIdentity, HostedAgentAuthorityMode, IncomingCallAction, Inkbox } from '@inkbox/sdk'
import type { VoiceStack } from '../config.js'
import { validateOpenAIRealtimeKey } from '../realtime.js'
import type { IdentityCredential, SetupPrompts } from './onboarding.js'
import { showQr, smsDraftLink, smsToQrPayload } from './qr.js'

export interface ChannelOptions {
  voiceStack?: VoiceStack
  voiceDefault?: VoiceStack
  realtimeApiKey?: string
  realtimeModel?: string
  realtimeVoice?: string
  callInstruction?: string
  enableIMessage?: boolean
  enableA2A?: boolean
  provisionPhone?: boolean
  phoneState?: string
  hostedAuthority?: 'contact_scoped' | 'yolo'
  nonInteractive?: boolean
}

export interface ChannelResult {
  identity: AgentIdentity
  voiceStack?: VoiceStack
  realtimeApiKey?: string
  realtimeModel?: string
  realtimeVoice?: string
  phoneProvisioned: boolean
  imessageEnabled: boolean
  a2aEnabled: boolean
}

export interface ChannelDependencies {
  validateRealtimeKey(apiKey: string, model: string): Promise<{ ok: boolean; detail: string }>
  createClient(apiKey: string): Inkbox
  sleep(milliseconds: number): Promise<void>
}

export const defaultChannelDependencies: ChannelDependencies = {
  validateRealtimeKey: (apiKey, model) => validateOpenAIRealtimeKey(apiKey, model),
  createClient: (apiKey) => new Inkbox({ apiKey }),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function configureChannels(
  credential: IdentityCredential,
  prompts: SetupPrompts | undefined,
  options: ChannelOptions,
  dependencies: ChannelDependencies = defaultChannelDependencies,
): Promise<ChannelResult> {
  let identity = await credential.client.getIdentity(credential.identity.agentHandle)
  const imessageEnabled = await configureIMessage(identity, credential.client, prompts, options, dependencies)
  const a2aEnabled = await configureA2A(identity, prompts, options)
  const phone = await configurePhone(identity, prompts, options)
  identity = phone.identity
  printIdentitySummary(identity)
  if (phone.provisioned && prompts) await waitForSmsOptIn(identity, dependencies)

  let voice: Pick<ChannelResult, 'voiceStack' | 'realtimeApiKey' | 'realtimeModel' | 'realtimeVoice'> = {}
  if (identity.phoneNumber || imessageEnabled) {
    voice = await configureVoice(identity, credential, prompts, options, dependencies)
  } else if (options.voiceStack) {
    throw new Error('A dedicated phone number is required to configure phone-call handling')
  }

  return {
    identity,
    ...voice,
    phoneProvisioned: phone.provisioned,
    imessageEnabled,
    a2aEnabled,
  }
}

function printIdentitySummary(identity: AgentIdentity): void {
  process.stdout.write('\nInkbox configured\n')
  process.stdout.write(`Handle: ${identity.agentHandle}\n`)
  process.stdout.write(`Mailbox: ${identity.emailAddress ?? 'none — set up later in the Inkbox console'}\n`)
  process.stdout.write(
    `Phone: ${identity.phoneNumber?.number ?? 'none — provision later in the Inkbox console'}\n`,
  )
  if (identity.phoneNumber?.number) {
    process.stdout.write(
      `Text START to ${identity.phoneNumber.number} to enable outbound SMS to your phone.\n`,
    )
    const fallbackLink = smsDraftLink(identity.phoneNumber.number, 'START')
    process.stdout.write('\nOr just scan this with your phone camera to draft that text in one tap:\n\n')
    if (!showQr(smsToQrPayload(identity.phoneNumber.number, 'START'))) {
      process.stdout.write(`Open this one-tap link instead: ${fallbackLink}\n`)
    }
  }
  process.stdout.write('Reachability rules: https://inkbox.ai/console/contact-rules\n')
}

export async function waitForSmsOptIn(
  identity: AgentIdentity,
  dependencies: Pick<ChannelDependencies, 'sleep'> = defaultChannelDependencies,
  attempts = Number.POSITIVE_INFINITY,
): Promise<void> {
  const number = identity.phoneNumber?.number
  if (!number) return
  process.stdout.write(`Waiting for an inbound START to ${number}. Press Ctrl+C to skip.\n`)
  const startedAt = new Date().toISOString()
  let interrupted = false
  const interrupt = () => {
    interrupted = true
  }
  process.once('SIGINT', interrupt)
  try {
    for (let attempt = 0; attempt < attempts && !interrupted; attempt += 1) {
      const texts = await identity.listTexts({ limit: 20, startDatetime: startedAt }).catch(() => [])
      const start = texts.find(
        (message) => message.direction === 'inbound' && message.text?.trim().toUpperCase() === 'START',
      )
      if (start) {
        process.stdout.write(`SMS opt-in confirmed from ${start.remotePhoneNumber ?? 'your phone'}.\n`)
        return
      }
      await dependencies.sleep(3_000)
    }
    process.stdout.write(
      interrupted
        ? `Skipped. Text START to ${number} anytime to enable outbound SMS.\n`
        : `No START text arrived yet. Text START to ${number} anytime to enable outbound SMS.\n`,
    )
  } finally {
    process.off('SIGINT', interrupt)
  }
}

export async function configureIMessage(
  identity: AgentIdentity,
  client: Inkbox,
  prompts: SetupPrompts | undefined,
  options: Pick<ChannelOptions, 'enableIMessage' | 'nonInteractive'>,
  dependencies: Pick<ChannelDependencies, 'sleep'> = defaultChannelDependencies,
): Promise<boolean> {
  process.stdout.write('\niMessage\n')
  process.stdout.write('Inkbox can make this agent reachable over iMessage from your iPhone.\n')
  process.stdout.write('No number to provision — you connect through the Inkbox iMessage router.\n')
  process.stdout.write(
    'Once connected, the agent can also make and take voice calls over that shared line.\n',
  )
  const existingAssignments = identity.imessageEnabled
    ? await identity.listIMessageAssignments({ limit: 1 }).catch(() => [])
    : []
  if (existingAssignments.length > 0) {
    const shouldCheck =
      options.enableIMessage ??
      (!options.nonInteractive && prompts
        ? await prompts.confirm('Connect another iPhone to this agent now?', false)
        : false)
    if (!shouldCheck) {
      process.stdout.write('iMessage is connected for this identity.\n')
      return true
    }
  }
  const shouldEnable =
    options.enableIMessage ??
    (!options.nonInteractive && prompts
      ? await prompts.confirm('Enable iMessage (RCS/SMS fallback and voice calls) for this agent?', true)
      : identity.imessageEnabled)
  if (!shouldEnable) return identity.imessageEnabled
  if (!identity.imessageEnabled) await identity.update({ imessageEnabled: true })

  const triage = await client.imessages.getTriageNumber()
  process.stdout.write('From your iPhone, in the Messages app:\n')
  process.stdout.write(`  1. Text "${triage.connectCommand}" to ${triage.number}.\n`)
  process.stdout.write('  2. Open the new thread from the number assigned to this agent.\n')
  process.stdout.write('  3. Send any first message, such as "hi", in that new thread.\n')
  process.stdout.write('The agent can only message you after you message it first.\n')
  const fallbackLink = smsDraftLink(triage.number, triage.connectCommand)
  process.stdout.write('\nOr just scan this with your iPhone camera to do step 1 in one tap:\n\n')
  if (!showQr(smsToQrPayload(triage.number, triage.connectCommand))) {
    process.stdout.write(`Open this one-tap link instead: ${fallbackLink}\n`)
  }
  if (!prompts || !(await prompts.confirm('Connect your iPhone to this agent now?', true))) return true
  await waitForIMessageConnection(identity, dependencies)
  return true
}

export async function waitForIMessageConnection(
  identity: AgentIdentity,
  dependencies: Pick<ChannelDependencies, 'sleep'> = defaultChannelDependencies,
  attempts = Number.POSITIVE_INFINITY,
): Promise<void> {
  process.stdout.write('Waiting for your first iMessage. Press Ctrl+C to skip.\n')
  const startedAt = new Date().toISOString()
  let interrupted = false
  const interrupt = () => {
    interrupted = true
  }
  process.once('SIGINT', interrupt)
  try {
    for (let attempt = 0; attempt < attempts && !interrupted; attempt += 1) {
      const messages = await identity
        .listIMessages({ limit: 10, includeGroups: false, startDatetime: startedAt })
        .catch(() => [])
      const inbound = messages.find((message) => message.direction === 'inbound')
      if (inbound) {
        await identity.sendIMessage({
          conversationId: inbound.conversationId,
          text: `You're connected! This is your iMessage channel to your DeepSeek agent @${identity.agentHandle}. Anything you send here goes straight to the agent, and its replies will show up right in this thread.`,
        })
        await identity.markIMessageConversationRead(inbound.conversationId).catch(() => undefined)
        process.stdout.write('First iMessage received and welcome message sent.\n')
        return
      }
      await dependencies.sleep(3_000)
    }
    process.stdout.write(
      interrupted
        ? 'Skipped. The agent replies over iMessage once you connect and message it.\n'
        : 'No iMessage connection arrived yet. You can finish it later by rerunning setup.\n',
    )
  } finally {
    process.off('SIGINT', interrupt)
  }
}

async function configureA2A(
  identity: AgentIdentity,
  _prompts: SetupPrompts | undefined,
  options: Pick<ChannelOptions, 'enableA2A' | 'nonInteractive'>,
): Promise<boolean> {
  const current = await identity.a2aSettings().catch(() => ({ enabled: false }))
  const shouldEnable = options.enableA2A ?? current.enabled
  if (shouldEnable && !current.enabled) await identity.a2aEnable()
  return current.enabled || shouldEnable
}

async function configurePhone(
  identity: AgentIdentity,
  prompts: SetupPrompts | undefined,
  options: Pick<ChannelOptions, 'provisionPhone' | 'phoneState' | 'nonInteractive'>,
): Promise<{ identity: AgentIdentity; provisioned: boolean }> {
  if (identity.phoneNumber) return { identity, provisioned: false }
  const shouldProvision =
    options.provisionPhone ??
    (!options.nonInteractive && prompts
      ? await prompts.confirm('Provision a dedicated phone number for SMS and voice?', true)
      : false)
  if (!shouldProvision) return { identity, provisioned: false }
  try {
    await identity.provisionPhoneNumber({
      type: 'local',
      ...(options.phoneState ? { state: options.phoneState.toUpperCase() } : {}),
    })
    const refreshed = await identity.refresh()
    process.stdout.write(`Phone number provisioned: ${refreshed.phoneNumber?.number ?? 'ready'}.\n`)
    process.stdout.write('To enable SMS replies, text START to the new number from your phone.\n')
    return { identity: refreshed, provisioned: true }
  } catch (error) {
    process.stdout.write('Dedicated phone numbers are available on Inkbox paid tiers.\n')
    process.stdout.write('See https://inkbox.ai/pricing for details.\n')
    process.stdout.write(`Provisioning response: ${errorMessage(error)}\n`)
    return { identity, provisioned: false }
  }
}

export async function configureVoice(
  identity: AgentIdentity,
  credential: IdentityCredential,
  prompts: SetupPrompts | undefined,
  options: ChannelOptions,
  dependencies: ChannelDependencies = defaultChannelDependencies,
): Promise<Pick<ChannelResult, 'voiceStack' | 'realtimeApiKey' | 'realtimeModel' | 'realtimeVoice'>> {
  let selected = options.voiceStack
  if (!selected && prompts) {
    const index = await prompts.choose(
      'Choose phone-call handling:',
      ['Inkbox hosted agent', 'OpenAI Realtime API'],
      options.voiceDefault === 'openai_realtime' ? 1 : 0,
    )
    selected = index === 0 ? 'inkbox_voice_ai' : 'openai_realtime'
  }
  if (!selected) return {}

  if (selected === 'openai_realtime') {
    const model = options.realtimeModel ?? 'gpt-realtime-2'
    const voice = options.realtimeVoice ?? 'cedar'
    const key =
      options.realtimeApiKey ?? (prompts ? await prompts.secret('OpenAI Realtime API key') : undefined)
    if (!key) throw new Error('OpenAI Realtime requires INKBOX_REALTIME_API_KEY or OPENAI_API_KEY')
    const validation = await dependencies.validateRealtimeKey(key, model)
    if (!validation.ok) {
      const error = new Error(`OpenAI Realtime validation failed: ${validation.detail}`)
      if (prompts && !options.voiceStack) {
        process.stderr.write(`${error.message}\n`)
        const { realtimeApiKey: _invalidKey, ...retryOptions } = options
        return configureVoice(identity, credential, prompts, retryOptions, dependencies)
      }
      throw error
    }
    const publicHost = identity.tunnel?.publicHost
    if (!publicHost) throw new Error('This identity does not have a public tunnel for OpenAI Realtime calls')
    await identity.setIncomingCallAction({
      incomingCallAction: IncomingCallAction.AUTO_ACCEPT,
      clientWebsocketUrl: `wss://${publicHost}/phone/media/ws`,
    })
    return { voiceStack: selected, realtimeApiKey: key, realtimeModel: model, realtimeVoice: voice }
  }

  const previousConfig = await identity.getHostedAgentConfig()
  const previousIncoming = await identity.getIncomingCallAction()
  let authority = options.hostedAuthority
  if (!authority && prompts) {
    const index = await prompts.choose('Choose hosted-agent authority:', [
      'Contact-scoped (recommended)',
      'Full agent authority (YOLO)',
    ])
    authority = index === 0 ? 'contact_scoped' : 'yolo'
  }
  authority ??= 'contact_scoped'
  let authorityIdentity = credential.authorityClient
    ? await credential.authorityClient.getIdentity(identity.agentHandle)
    : undefined
  const authorityMode =
    authority === 'yolo' ? HostedAgentAuthorityMode.YOLO : HostedAgentAuthorityMode.CONTACT_SCOPED
  try {
    await identity.setHostedAgentConfig({
      ...(options.callInstruction?.trim() ? { instructions: options.callInstruction.trim() } : {}),
    })
    if (previousConfig.authorityMode !== authorityMode) {
      if (!authorityIdentity) {
        if (!prompts)
          throw new Error('Changing hosted-agent authority requires an admin-scoped Inkbox API key')
        const adminKey = await prompts.secret('Admin-scoped Inkbox API key for hosted-agent authority')
        const adminClient = dependencies.createClient(adminKey)
        const whoami = await adminClient.whoami()
        if (whoami.authType !== 'api_key' || whoami.authSubtype !== 'api_key.admin_scoped')
          throw new Error('Changing hosted-agent authority requires an admin-scoped Inkbox API key')
        authorityIdentity = await adminClient.getIdentity(identity.agentHandle)
      }
      await authorityIdentity.setHostedAgentAuthorityMode({ authorityMode })
    }
    await identity.setIncomingCallAction({ incomingCallAction: IncomingCallAction.HOSTED_AGENT })
    return { voiceStack: selected }
  } catch (error) {
    await identity
      .setHostedAgentConfig({
        ...(previousConfig.voice ? { voice: previousConfig.voice } : {}),
        ...(previousConfig.model ? { model: previousConfig.model } : {}),
        ...(previousConfig.instructions ? { instructions: previousConfig.instructions } : {}),
      })
      .catch(() => {})
    await identity
      .setIncomingCallAction({
        incomingCallAction: previousIncoming.incomingCallAction,
        ...(previousIncoming.clientWebsocketUrl
          ? { clientWebsocketUrl: previousIncoming.clientWebsocketUrl }
          : {}),
        ...(previousIncoming.incomingCallWebhookUrl
          ? { incomingCallWebhookUrl: previousIncoming.incomingCallWebhookUrl }
          : {}),
        ...(previousIncoming.forwardingTargetType
          ? { forwardingTargetType: previousIncoming.forwardingTargetType }
          : {}),
        ...(previousIncoming.forwardingPhoneNumber
          ? { forwardingPhoneNumber: previousIncoming.forwardingPhoneNumber }
          : {}),
        ...(previousIncoming.forwardingSipUri ? { forwardingSipUri: previousIncoming.forwardingSipUri } : {}),
      })
      .catch(() => {})
    if (authorityIdentity && previousConfig.authorityMode !== authorityMode)
      await authorityIdentity
        .setHostedAgentAuthorityMode({ authorityMode: previousConfig.authorityMode })
        .catch(() => {})
    if (prompts && !options.voiceStack) {
      process.stderr.write(`Hosted-agent configuration failed: ${errorMessage(error)}\n`)
      const { hostedAuthority: _failedAuthority, ...retryOptions } = options
      return configureVoice(identity, credential, prompts, retryOptions, dependencies)
    }
    throw error
  }
}
