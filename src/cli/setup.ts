import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BUILTIN_CHANNEL_INSTRUCTIONS } from '../channel-instructions.js'
import type { VoiceStack } from '../config.js'
import { PLUGIN_PACKAGE, PROFILE_NAME } from '../constants.js'
import { configureChannels } from './channels.js'
import { credentialFromEnvironment, credentialNamesFromEnvironment, layeredEnvironment } from './env.js'
import { readYaml, updateYaml } from './files.js'
import { installLauncher } from './launcher.js'
import type { SetupPrompts } from './onboarding.js'
import { reconcileSigningKey, resolveIdentityCredential } from './onboarding.js'
import type { Paths } from './paths.js'
import { CommandError, run } from './process.js'
import { Prompts } from './prompts.js'
import { manageService, serviceInstalled } from './service.js'
import { readRuntimeStatus } from './status.js'

const DSH_VERSION = '0.1.1-rc.2'

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
    const savedVoiceStack =
      savedSettings.voiceStack === 'openai_realtime' ? 'openai_realtime' : 'inkbox_voice_ai'
    const savedChannelInstructions = object(savedSettings.channelInstructions)
    const deepseekKey = env.DEEPSEEK_API_KEY
    if (!deepseekKey)
      throw new Error('DEEPSEEK_API_KEY was not found in the environment or ~/.env. Add it and rerun setup.')

    const inkboxKey = await selectEnvironmentCredential(env, options.inkboxKeyEnv, prompts)
    const credential = await resolveIdentityCredential(inkboxKey, options.identity, prompts)
    const signingKey = await reconcileSigningKey(
      credential.identity,
      env.INKBOX_WEBHOOK_SIGNING_KEY,
      prompts,
      options.rotateSigningKey,
    )
    const workspace = resolve(options.workspace ?? process.cwd())
    await mkdir(workspace, { recursive: true })

    process.stdout.write('Installing the DeepSeek Harness runtime and Inkbox bundle...\n')
    await ensureRuntime(paths)
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
      refs.INKBOX_WEBHOOK_SIGNING_KEY = signingKey
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
    const autoApproveInkboxTools = await resolveToolApprovalChoice(
      options.autoApproveInkboxTools,
      savedSettings.autoApproveInkboxTools,
      prompts,
    )

    await updateYaml(join(paths.dshHome, '.credentials.yaml'), (document) => {
      const refs = object(document.refs)
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
  prompts: Pick<SetupPrompts, 'confirm'> | undefined,
): Promise<boolean> {
  if (requested !== undefined) return requested
  const previous = typeof saved === 'boolean' ? saved : undefined
  if (!prompts) return previous ?? false
  process.stdout.write('\nInkbox tool approvals\n')
  process.stdout.write(
    'Trusting Inkbox tools skips repeated prompts for messages, calls, contacts, and other Inkbox actions. Other Harness tools are unchanged.\n',
  )
  return prompts.confirm('Allow this agent to run Inkbox tools without asking each time?', previous ?? true)
}

export interface ServiceSetupDependencies {
  isInstalled(paths: Paths): Promise<boolean>
  manage(action: 'install' | 'restart', paths: Paths, workspace: string): Promise<string>
  waitUntilReady(paths: Paths): Promise<boolean>
}

const defaultServiceSetupDependencies: ServiceSetupDependencies = {
  isInstalled: serviceInstalled,
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
  let started = false
  let ready = false
  const wantsService =
    options.service ??
    (prompts ? await prompts.confirm('Install a managed background service?', true) : false)
  if (!wantsService) return { installed, started, ready }
  if (!installed) {
    try {
      process.stdout.write(`${await dependencies.manage('install', paths, workspace)}\n`)
      installed = true
    } catch (error) {
      process.stderr.write(`Managed service installation failed: ${errorMessage(error)}\n`)
      process.stderr.write('Foreground mode is still available with inkbox-deepseek run.\n')
      return { installed, started, ready }
    }
  }
  const wantsStart =
    options.start ?? (prompts ? await prompts.confirm('Start or restart DeepSeek Harness now?', true) : false)
  if (!wantsStart) return { installed, started, ready }
  try {
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

async function selectEnvironmentCredential(
  env: Readonly<Record<string, string>>,
  selectedName: string | undefined,
  prompts: Prompts | undefined,
): Promise<string | undefined> {
  if (env.INKBOX_API_KEY || selectedName !== undefined)
    return credentialFromEnvironment(env, 'INKBOX_API_KEY', selectedName)
  const variants = credentialNamesFromEnvironment(env, 'INKBOX_API_KEY')
  if (variants.length > 1 && prompts) {
    const index = await prompts.choose(
      'Choose the Inkbox credential from your environment:',
      variants.map(([name]) => name),
    )
    return variants[index]?.[1]
  }
  return credentialFromEnvironment(env, 'INKBOX_API_KEY')
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

function printSummary(
  identity: { agentHandle: string; emailAddress?: string | null; phoneNumber?: { number: string } | null },
  voiceStack: VoiceStack | undefined,
  paths: Paths,
  started: boolean,
  ready: boolean,
): void {
  process.stdout.write(`\nSetup complete for ${identity.agentHandle}.\n`)
  process.stdout.write(`Email: ${identity.emailAddress ?? 'not provisioned'}\n`)
  process.stdout.write(`Phone: ${identity.phoneNumber?.number ?? 'not provisioned'}\n`)
  if (voiceStack)
    process.stdout.write(
      `Calls: ${voiceStack === 'inkbox_voice_ai' ? 'Inkbox hosted agent' : 'OpenAI Realtime API'}\n`,
    )
  process.stdout.write(`Profile: ${PROFILE_NAME} under ${paths.dshHome}\n`)
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

async function ensureRuntime(paths: Paths): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 })
  const manifestPath = join(paths.runtimeDir, 'package.json')
  let manifest: Record<string, unknown> = {}
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  manifest.name = 'inkbox-deepseek-runtime'
  manifest.private = true
  manifest.type = 'module'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await run('pnpm', ['add', '--save-exact', `@deepseek-ai/dsh@${DSH_VERSION}`], { cwd: paths.runtimeDir })
  } catch (error) {
    const message =
      error instanceof CommandError
        ? `${error.stdout}\n${error.stderr}`
        : error instanceof Error
          ? error.message
          : String(error)
    const match = /Ignored build scripts:\s*([^\n]+)/i.exec(message)
    if (match?.[1] === undefined) throw error
    const packages = match[1]
      .split(',')
      .map((value) => value.trim().replace(/@\d[^,]*$/, ''))
      .filter(Boolean)
    if (packages.length === 0) throw error
    process.stdout.write('Completing approved Harness dependency builds...\n')
    await run(
      'pnpm',
      ['add', `--allow-build=${packages.join(',')}`, '--save-exact', `@deepseek-ai/dsh@${DSH_VERSION}`],
      { cwd: paths.runtimeDir, stdio: 'inherit' },
    )
  }
  await access(paths.dshBin)
}
