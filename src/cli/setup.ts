import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BUILTIN_CHANNEL_INSTRUCTIONS } from '../channel-instructions.js'
import type { VoiceStack } from '../config.js'
import { PLUGIN_PACKAGE, PROFILE_NAME } from '../constants.js'
import { configureAvatar } from './avatar.js'
import { configureChannels } from './channels.js'
import { credentialFromEnvironment, layeredEnvironment } from './env.js'
import { readYaml, updateYaml } from './files.js'
import { validateHarness } from './harness.js'
import { installLauncher } from './launcher.js'
import type { SetupPrompts } from './onboarding.js'
import { reconcileSigningKey, resolveIdentityCredential } from './onboarding.js'
import type { Paths } from './paths.js'
import { CommandError, run } from './process.js'
import { Prompts } from './prompts.js'
import { manageService, serviceInstalled } from './service.js'
import { readRuntimeStatus } from './status.js'

export interface SetupOptions {
  identity?: string
  workspace?: string
  pluginSpec?: string
  inkboxKeyEnv?: string
  realtimeKeyEnv?: string
  nonInteractive?: boolean
  service?: boolean
  start?: boolean
  rotateSigningKey?: boolean
  voiceStack?: VoiceStack
  realtimeModel?: string
  realtimeVoice?: string
  autoApproveInkboxTools?: boolean
  hostedAuthority?: 'contact_scoped' | 'yolo'
  enableIMessage?: boolean
  enableA2A?: boolean
  provisionPhone?: boolean
  phoneState?: string
}

export interface SetupResult {
  identity: string
  dshHome: string
  workspace: string
  serviceInstalled: boolean
  serviceStarted: boolean
  gatewayReady: boolean
  voiceStack?: VoiceStack
}

export async function setup(paths: Paths, options: SetupOptions): Promise<SetupResult> {
  const prompts = options.nonInteractive ? undefined : new Prompts()
  try {
    process.stdout.write('\nInkbox for DeepSeek Harness\n\n')
    const env = await layeredEnvironment(paths.home)
    const savedSettings = object((await readYaml(join(paths.dshHome, 'settings.yaml')))?.inkbox)
    const savedCredentials = object((await readYaml(join(paths.dshHome, '.credentials.yaml')))?.refs)
    const savedVoiceStack =
      savedSettings.voiceStack === 'openai_realtime' ? 'openai_realtime' : 'inkbox_voice_ai'
    const savedChannelInstructions = object(savedSettings.channelInstructions)
    await validateHarness(paths)
    const deepseekKey = resolveDeepSeekCredential(env, savedCredentials)
    if (!deepseekKey)
      throw new Error(
        'DeepSeek Harness is not configured with DEEPSEEK_API_KEY. Configure the Harness or add the key to your environment or ~/.env, then rerun setup.',
      )

    if (
      prompts &&
      typeof savedCredentials.INKBOX_API_KEY === 'string' &&
      typeof savedSettings.agentHandle === 'string'
    ) {
      process.stdout.write(`Inkbox is already configured for identity '${savedSettings.agentHandle}'.\n`)
      if (!(await prompts.confirm('Reconfigure Inkbox?', false)))
        return existingSetupResult(paths, savedSettings)
    }

    const inkboxKey = await selectInkboxCredential(env, options.inkboxKeyEnv, prompts)
    const credential = await resolveIdentityCredential(inkboxKey, options.identity, prompts)
    await configureAvatar(credential.identity, credential.apiKey, prompts, {
      ...(env.INKBOX_BASE_URL ? { baseUrl: env.INKBOX_BASE_URL } : {}),
      isSignup: inkboxKey === undefined,
    })
    process.stdout.write('\nInkbox authorization lives server-side through contact rules.\n')
    process.stdout.write(
      'Anyone allowed by those rules reaches the agent; there is no second local allowlist.\n',
    )
    const workspace = resolve(options.workspace ?? process.cwd())
    await mkdir(workspace, { recursive: true })

    process.stdout.write('Installing the Inkbox bundle into DeepSeek Harness...\n')
    const pluginSpec = options.pluginSpec ?? (await stagePluginPackage(paths))
    if (isLocalPluginSpec(pluginSpec) && (await profileHasBundle(paths))) {
      await run(paths.dshBin, ['plugin', '--profile', PROFILE_NAME, 'remove', PLUGIN_PACKAGE], {
        cwd: workspace,
        env: { ...process.env, DSH_HOME: paths.dshHome },
      })
    }
    await run(paths.dshBin, ['plugin', '--profile', PROFILE_NAME, 'add', '--force', pluginSpec], {
      cwd: workspace,
      env: { ...process.env, DSH_HOME: paths.dshHome },
      stdio: 'inherit',
    })
    const launcher = await installLauncher(paths)
    if (!launcher.installed) {
      process.stdout.write(`CLI launcher not installed at ${launcher.path}: ${launcher.reason}.\n`)
    } else if (!launcher.onPath) {
      process.stdout.write(`Add ${paths.localBin} to PATH to run inkbox-deepseek directly.\n`)
    }

    await updateYaml(join(paths.dshHome, '.credentials.yaml'), (document) => {
      document.version = 1
      const refs = object(document.refs)
      refs.INKBOX_API_KEY = credential.apiKey
      refs.DEEPSEEK_API_KEY = deepseekKey
      if (env.INKBOX_WEBHOOK_SECRET_GITHUB)
        refs.INKBOX_WEBHOOK_SECRET_GITHUB = env.INKBOX_WEBHOOK_SECRET_GITHUB
      document.refs = refs
    })
    await updateYaml(join(paths.dshHome, 'settings.yaml'), (document) => {
      document.inkbox = {
        ...object(document.inkbox),
        enabled: true,
        agentHandle: credential.identity.agentHandle,
        workspace,
        stateDir: join(paths.dshHome, 'inkbox'),
      }
    })

    const realtimeKey = selectRealtimeCredential(env, options.realtimeKeyEnv)
    const channels = await configureChannels(credential, prompts, {
      ...(options.voiceStack ? { voiceStack: options.voiceStack } : {}),
      voiceDefault: savedVoiceStack,
      ...(realtimeKey ? { realtimeApiKey: realtimeKey } : {}),
      realtimeModel:
        options.realtimeModel ??
        (typeof savedSettings.realtimeModel === 'string' ? savedSettings.realtimeModel : 'gpt-realtime-2'),
      realtimeVoice:
        options.realtimeVoice ??
        (typeof savedSettings.realtimeVoice === 'string' ? savedSettings.realtimeVoice : 'cedar'),
      callInstruction: [
        BUILTIN_CHANNEL_INSTRUCTIONS.call,
        typeof savedChannelInstructions.call === 'string' ? savedChannelInstructions.call.trim() : '',
      ]
        .filter(Boolean)
        .join('\n'),
      ...(options.hostedAuthority ? { hostedAuthority: options.hostedAuthority } : {}),
      ...(options.enableIMessage !== undefined ? { enableIMessage: options.enableIMessage } : {}),
      ...(options.enableA2A !== undefined ? { enableA2A: options.enableA2A } : {}),
      ...(options.provisionPhone !== undefined ? { provisionPhone: options.provisionPhone } : {}),
      ...(options.phoneState ? { phoneState: options.phoneState } : {}),
      nonInteractive: options.nonInteractive ?? false,
    })
    const signingKey = await reconcileSigningKey(
      channels.identity,
      typeof savedCredentials.INKBOX_WEBHOOK_SIGNING_KEY === 'string'
        ? savedCredentials.INKBOX_WEBHOOK_SIGNING_KEY
        : env.INKBOX_WEBHOOK_SIGNING_KEY,
      prompts,
      options.rotateSigningKey,
    )
    const autoApproveInkboxTools = await resolveToolApprovalChoice(
      options.autoApproveInkboxTools,
      savedSettings.autoApproveInkboxTools,
      prompts,
    )

    await updateYaml(join(paths.dshHome, '.credentials.yaml'), (document) => {
      const refs = object(document.refs)
      refs.INKBOX_WEBHOOK_SIGNING_KEY = signingKey
      if (channels.realtimeApiKey) refs.INKBOX_REALTIME_API_KEY = channels.realtimeApiKey
      document.refs = refs
    })

    await updateYaml(join(paths.dshHome, 'settings.yaml'), (document) => {
      document.inkbox = {
        ...object(document.inkbox),
        agentHandle: channels.identity.agentHandle,
        ...(channels.voiceStack ? { voiceStack: channels.voiceStack } : {}),
        ...(channels.realtimeModel ? { realtimeModel: channels.realtimeModel } : {}),
        ...(channels.realtimeVoice ? { realtimeVoice: channels.realtimeVoice } : {}),
        autoApproveInkboxTools,
      }
    })

    const service = await configureManagedService(paths, workspace, options, prompts)
    const { installed, started, ready } = service

    printSummary(channels.identity, channels.voiceStack, paths, started, ready)
    return {
      identity: channels.identity.agentHandle,
      dshHome: paths.dshHome,
      workspace,
      serviceInstalled: installed,
      serviceStarted: started,
      gatewayReady: ready,
      ...(channels.voiceStack ? { voiceStack: channels.voiceStack } : {}),
    }
  } finally {
    prompts?.close()
  }
}

export async function resolveToolApprovalChoice(
  requested: boolean | undefined,
  saved: unknown,
  prompts: SetupPrompts | undefined,
): Promise<boolean> {
  if (requested !== undefined) return requested
  const previous = typeof saved === 'boolean' ? saved : undefined
  return previous ?? Boolean(prompts)
}

export interface ServiceSetupDependencies {
  isInstalled(paths: Paths): Promise<boolean>
  isRunning(paths: Paths): Promise<boolean>
  manage(action: 'install' | 'restart', paths: Paths, workspace: string): Promise<string>
  waitUntilReady(paths: Paths): Promise<boolean>
}

const defaultServiceSetupDependencies: ServiceSetupDependencies = {
  isInstalled: serviceInstalled,
  isRunning: async (paths) => {
    const status = await readRuntimeStatus(paths).catch(() => undefined)
    return status?.processRunning ?? false
  },
  manage: manageService,
  waitUntilReady: waitForGatewayReady,
}

export async function configureManagedService(
  paths: Paths,
  workspace: string,
  options: Pick<SetupOptions, 'service' | 'start'>,
  prompts: Pick<SetupPrompts, 'confirm'> | undefined,
  dependencies: ServiceSetupDependencies = defaultServiceSetupDependencies,
): Promise<{ installed: boolean; started: boolean; ready: boolean }> {
  let installed = await dependencies.isInstalled(paths)
  const running = await dependencies.isRunning(paths)
  let started = false
  let ready = false
  if (running) {
    const wantsRestart =
      options.start ?? (prompts ? await prompts.confirm('Restart the running gateway now?', true) : false)
    if (!wantsRestart) return { installed, started: true, ready: true }
    try {
      await dependencies.manage('install', paths, workspace)
      installed = true
      await dependencies.manage('restart', paths, workspace)
      started = true
      ready = await dependencies.waitUntilReady(paths)
      return { installed, started, ready }
    } catch (error) {
      process.stderr.write(`Could not restart the managed service: ${errorMessage(error)}\n`)
      return { installed, started, ready }
    }
  }

  const question = installed
    ? 'The gateway service is installed but stopped. Launch it now?'
    : 'Install and launch the gateway service now?'
  const wantsStart =
    options.start ?? options.service ?? (prompts ? await prompts.confirm(question, true) : false)
  if (!wantsStart) return { installed, started, ready }
  try {
    process.stdout.write(`${await dependencies.manage('install', paths, workspace)}\n`)
    installed = true
    await dependencies.manage('restart', paths, workspace)
    started = true
    ready = await dependencies.waitUntilReady(paths)
    process.stdout.write(
      ready
        ? 'DeepSeek Harness is running and the Inkbox gateway is connected.\n'
        : 'The service was started but the gateway is not ready yet. Run inkbox-deepseek doctor.\n',
    )
  } catch (error) {
    process.stderr.write(`Could not start the managed service: ${errorMessage(error)}\n`)
    process.stderr.write('Start in the foreground with inkbox-deepseek run.\n')
  }
  return { installed, started, ready }
}

export async function selectInkboxCredential(
  env: Readonly<Record<string, string>>,
  selectedName: string | undefined,
  prompts: Pick<SetupPrompts, 'confirm' | 'secret'> | undefined,
): Promise<string | undefined> {
  if (selectedName !== undefined) return credentialFromEnvironment(env, 'INKBOX_API_KEY', selectedName)
  if (!prompts) return credentialFromEnvironment(env, 'INKBOX_API_KEY')
  process.stdout.write('If you do not have an Inkbox API key yet, that is fine.\n')
  process.stdout.write('We can create a fresh agent identity for you via self-signup.\n')
  if (!(await prompts.confirm('Do you already have an Inkbox API key?', false))) return undefined
  const key = (await prompts.secret('Paste your Inkbox API key (ApiKey_...)')).trim()
  if (!key) throw new Error('No Inkbox API key was provided')
  return key
}

async function existingSetupResult(paths: Paths, settings: Record<string, unknown>): Promise<SetupResult> {
  const status = await readRuntimeStatus(paths).catch(() => undefined)
  return {
    identity: String(settings.agentHandle),
    dshHome: paths.dshHome,
    workspace: typeof settings.workspace === 'string' ? settings.workspace : process.cwd(),
    serviceInstalled: await serviceInstalled(paths),
    serviceStarted: status?.processRunning ?? false,
    gatewayReady: Boolean(status?.ready && status.connected && status.processRunning),
    ...(settings.voiceStack === 'inkbox_voice_ai' || settings.voiceStack === 'openai_realtime'
      ? { voiceStack: settings.voiceStack }
      : {}),
  }
}

export function selectRealtimeCredential(
  env: Readonly<Record<string, string>>,
  selectedName?: string,
): string | undefined {
  if (selectedName) {
    const value = env[selectedName]
    if (!value) throw new Error(`${selectedName} is not set or is empty`)
    return value
  }
  return env.INKBOX_REALTIME_API_KEY || env.OPENAI_API_KEY
}

export function resolveDeepSeekCredential(
  env: Readonly<Record<string, string>>,
  savedCredentials: Readonly<Record<string, unknown>>,
): string | undefined {
  return (
    env.DEEPSEEK_API_KEY ??
    (typeof savedCredentials.DEEPSEEK_API_KEY === 'string' ? savedCredentials.DEEPSEEK_API_KEY : undefined)
  )
}

export async function waitForGatewayReady(
  paths: Paths,
  attempts = 30,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await readRuntimeStatus(paths)
      if (status.ready && status.connected && status.processRunning) return true
    } catch {}
    await sleep(1_000)
  }
  return false
}

export function printSummary(
  identity: { agentHandle: string; emailAddress?: string | null; phoneNumber?: { number: string } | null },
  voiceStack: VoiceStack | undefined,
  paths: Paths,
  started: boolean,
  ready: boolean,
): void {
  if (started && ready) {
    const rows = [
      ['Inkbox identity', identity.agentHandle],
      ['Check its health', 'inkbox-deepseek doctor'],
    ] as const
    const labelWidth = Math.max(...rows.map(([label]) => label.length + 1))
    const body = [
      'Your DeepSeek agent is set up and running on Inkbox.',
      '',
      ...rows.map(([label, value]) => `  ${`${label}:`.padEnd(labelWidth)}  ${value}`),
    ]
    const width = Math.max(...body.map((line) => line.length)) + 4
    process.stdout.write(`\n╭${'─'.repeat(width - 2)}╮\n`)
    body.forEach((line) => {
      process.stdout.write(`│ ${line.padEnd(width - 4)} │\n`)
    })
    process.stdout.write(`╰${'─'.repeat(width - 2)}╯\n`)
    return
  }
  process.stdout.write(
    started && !ready
      ? `\nSetup saved for ${identity.agentHandle}, but the gateway is not ready.\n`
      : `\nSetup complete for ${identity.agentHandle}.\n`,
  )
  process.stdout.write(`Email: ${identity.emailAddress ?? 'not provisioned'}\n`)
  process.stdout.write(`Phone: ${identity.phoneNumber?.number ?? 'not provisioned'}\n`)
  if (voiceStack)
    process.stdout.write(
      `Calls: ${voiceStack === 'inkbox_voice_ai' ? 'Inkbox hosted agent' : 'OpenAI Realtime API'}\n`,
    )
  process.stdout.write(`Profile: ${PROFILE_NAME} under ${paths.dshHome}\n`)
  process.stdout.write('\nReachability rules\n')
  process.stdout.write('Open https://inkbox.ai/console/contact-rules to control who can reach this agent.\n')
  process.stdout.write('You can allow or block contacts, phone numbers, email addresses, and domains.\n')
  process.stdout.write('Run diagnostics: inkbox-deepseek doctor\n')
  if (!started) process.stdout.write('Start in the foreground: inkbox-deepseek run\n')
  else if (!ready) process.stdout.write('Check readiness: inkbox-deepseek status\n')
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isLocalPluginSpec(spec: string): boolean {
  return spec.startsWith('/') || spec.startsWith('.') || spec.startsWith('file:')
}

async function profileHasBundle(paths: Paths): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(join(paths.dshHome, 'profiles', PROFILE_NAME, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, unknown> }
    return manifest.dependencies?.[PLUGIN_PACKAGE] !== undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function stagePluginPackage(paths: Paths): Promise<string> {
  const packageDir = join(paths.dshHome, 'inkbox-packages')
  await mkdir(packageDir, { recursive: true, mode: 0o700 })
  let result: Awaited<ReturnType<typeof run>>
  try {
    result = await run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packageDir], {
      cwd: paths.packageRoot,
    })
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    const detail = error.stderr.trim() || error.stdout.trim() || error.message
    throw new Error(`Could not stage the Inkbox bundle: ${detail}`)
  }
  const filename = result.stdout.trim().split(/\r?\n/).at(-1)
  if (!filename?.endsWith('.tgz')) throw new Error('npm did not return the staged plugin package name')
  return join(packageDir, filename)
}
