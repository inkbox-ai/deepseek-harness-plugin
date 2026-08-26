import { type AgentIdentity, HostedAgentAuthorityMode, IncomingCallAction, Inkbox } from '@inkbox/sdk'
import type { VoiceStack } from '../config.js'
import { validateOpenAIRealtimeKey } from '../realtime.js'
import type { IdentityCredential, SetupPrompts } from './onboarding.js'

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

  let voice: Pick<ChannelResult, 'voiceStack' | 'realtimeApiKey' | 'realtimeModel' | 'realtimeVoice'> = {}
  if (identity.phoneNumber) {
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

export async function configureIMessage(
  identity: AgentIdentity,
  client: Inkbox,
  prompts: SetupPrompts | undefined,
  options: Pick<ChannelOptions, 'enableIMessage' | 'nonInteractive'>,
  dependencies: Pick<ChannelDependencies, 'sleep'> = defaultChannelDependencies,
): Promise<boolean> {
  const existingAssignments = identity.imessageEnabled
    ? await identity.listIMessageAssignments({ limit: 1 }).catch(() => [])
    : []
  if (existingAssignments.length > 0) {
    const shouldCheck =
      options.enableIMessage ??
      (!options.nonInteractive && prompts
        ? await prompts.confirm('iMessage is already connected. Show connection setup again?', false)
        : false)
    if (!shouldCheck) {
      process.stdout.write('iMessage is connected for this identity.\n')
      return true
    }
  }
  const shouldEnable =
    options.enableIMessage ??
    (!options.nonInteractive && prompts
      ? await prompts.confirm('Enable shared-line iMessage?', true)
      : identity.imessageEnabled)
  if (!shouldEnable) return identity.imessageEnabled
  if (!identity.imessageEnabled) await identity.update({ imessageEnabled: true })

  const assignments =
    existingAssignments.length > 0
      ? existingAssignments
      : await identity.listIMessageAssignments({ limit: 1 }).catch(() => [])
  if (assignments.length > 0) {
    process.stdout.write('iMessage is connected for this identity.\n')
    return true
  }
  const triage = await client.imessages.getTriageNumber()
  process.stdout.write(`To connect iMessage, send "${triage.connectCommand}" to ${triage.number}.\n`)
  if (!prompts || !(await prompts.confirm('Wait for the first iMessage connection now?', true))) return true
  await waitForIMessageConnection(identity, dependencies)
  return true
}

export async function waitForIMessageConnection(
  identity: AgentIdentity,
  dependencies: Pick<ChannelDependencies, 'sleep'> = defaultChannelDependencies,
  attempts = 60,
): Promise<void> {
  process.stdout.write('Waiting for the iMessage connection...\n')
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [assignment] = await identity.listIMessageAssignments({ limit: 1 })
    if (assignment) {
      await identity.sendIMessage({
        to: assignment.remoteNumber,
        text: `Connected to ${identity.agentHandle}. You can message this agent here anytime.`,
      })
      process.stdout.write('iMessage connected and welcome message sent.\n')
      return
    }
    await dependencies.sleep(2_000)
  }
  process.stdout.write('No iMessage connection arrived yet. You can finish it later with the same command.\n')
}

async function configureA2A(
  identity: AgentIdentity,
  prompts: SetupPrompts | undefined,
  options: Pick<ChannelOptions, 'enableA2A' | 'nonInteractive'>,
): Promise<boolean> {
  const current = await identity.a2aSettings().catch(() => ({ enabled: false }))
  const shouldEnable =
    options.enableA2A ??
    (!options.nonInteractive && prompts
      ? await prompts.confirm('Enable agent-to-agent communication?', current.enabled)
      : current.enabled)
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
  const state = (
    options.phoneState ?? (prompts ? await prompts.text('US state abbreviation', 'NY') : 'NY')
  ).toUpperCase()
  if (!/^[A-Z]{2}$/.test(state)) throw new Error('Phone state must be a two-letter US abbreviation')
  try {
    await identity.provisionPhoneNumber({ state })
    const refreshed = await identity.refresh()
    process.stdout.write(`Phone number provisioned: ${refreshed.phoneNumber?.number ?? 'ready'}.\n`)
    process.stdout.write('To enable SMS replies, text START to the new number from your phone.\n')
    return { identity: refreshed, provisioned: true }
  } catch (error) {
    process.stderr.write(`Phone provisioning could not be completed: ${errorMessage(error)}\n`)
    process.stderr.write('Setup will continue. You can provision a phone number later and rerun setup.\n')
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
