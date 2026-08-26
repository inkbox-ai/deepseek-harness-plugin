import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { IncomingCallAction, Inkbox } from '@inkbox/sdk'
import { PLUGIN_PACKAGE, PROFILE_NAME } from '../constants.js'
import { credentialFromEnvironment, credentialNamesFromEnvironment, layeredEnvironment } from './env.js'
import { updateYaml } from './files.js'
import { installLauncher } from './launcher.js'
import type { Paths } from './paths.js'
import { CommandError, run } from './process.js'
import { Prompts } from './prompts.js'
import { manageService, serviceInstalled } from './service.js'

const DSH_VERSION = '0.1.1-rc.2'

export interface SetupOptions {
  identity?: string
  workspace?: string
  pluginSpec?: string
  inkboxKeyEnv?: string
  nonInteractive?: boolean
  service?: boolean
  start?: boolean
}

export interface SetupResult {
  identity: string
  dshHome: string
  workspace: string
  serviceInstalled: boolean
  serviceStarted: boolean
}

export async function setup(paths: Paths, options: SetupOptions): Promise<SetupResult> {
  const prompts = options.nonInteractive ? undefined : new Prompts()
  try {
    process.stdout.write('\nInkbox for DeepSeek Harness\n\n')
    const env = await layeredEnvironment(paths.home)
    let selectedKeyName = options.inkboxKeyEnv
    if (!env.INKBOX_API_KEY && selectedKeyName === undefined && prompts !== undefined) {
      const variants = credentialNamesFromEnvironment(env, 'INKBOX_API_KEY')
      if (variants.length > 1) {
        const index = await prompts.choose(
          'Choose the Inkbox credential from your environment:',
          variants.map(([name]) => name),
        )
        selectedKeyName = variants[index]?.[0]
      }
    }
    const credentials = await resolveIdentityCredential(
      credentialFromEnvironment(env, 'INKBOX_API_KEY', selectedKeyName),
      options.identity,
      prompts,
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
      const refs =
        typeof document.refs === 'object' && document.refs !== null && !Array.isArray(document.refs)
          ? (document.refs as Record<string, unknown>)
          : {}
      refs.INKBOX_API_KEY = credentials.apiKey
      if (env.DEEPSEEK_API_KEY) refs.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY
      if (env.INKBOX_WEBHOOK_SIGNING_KEY) refs.INKBOX_WEBHOOK_SIGNING_KEY = env.INKBOX_WEBHOOK_SIGNING_KEY
      if (env.INKBOX_WEBHOOK_SECRET_GITHUB)
        refs.INKBOX_WEBHOOK_SECRET_GITHUB = env.INKBOX_WEBHOOK_SECRET_GITHUB
      document.refs = refs
    })
    if (!env.DEEPSEEK_API_KEY) {
      throw new Error('DEEPSEEK_API_KEY was not found in the environment or ~/.env. Add it and rerun setup.')
    }

    await updateYaml(join(paths.dshHome, 'settings.yaml'), (document) => {
      document.inkbox = {
        ...(typeof document.inkbox === 'object' && document.inkbox !== null
          ? (document.inkbox as Record<string, unknown>)
          : {}),
        enabled: true,
        agentHandle: credentials.identity.agentHandle,
        workspace,
        stateDir: join(paths.dshHome, 'inkbox'),
      }
    })

    if (prompts !== undefined)
      await configureChannels(credentials.client, credentials.identity.agentHandle, prompts)

    let installed = await serviceInstalled(paths)
    let started = false
    const wantsService =
      options.service ??
      (prompts ? await prompts.confirm('Install a managed background service?', true) : false)
    if (wantsService) {
      process.stdout.write(`${await manageService('install', paths, workspace)}\n`)
      installed = true
      const wantsStart =
        options.start ??
        (prompts
          ? await prompts.confirm(
              installed ? 'Start or restart DeepSeek Harness now?' : 'Start DeepSeek Harness now?',
              true,
            )
          : false)
      if (wantsStart) {
        await manageService(installed ? 'restart' : 'start', paths, workspace)
        started = true
      }
    }

    process.stdout.write(`\nSetup complete for ${credentials.identity.agentHandle}.\n`)
    process.stdout.write(`Profile: ${PROFILE_NAME} under ${paths.dshHome}\n`)
    process.stdout.write(`Run diagnostics: inkbox-deepseek doctor\n`)
    if (!started) process.stdout.write('Start in the foreground: inkbox-deepseek run\n')
    return {
      identity: credentials.identity.agentHandle,
      dshHome: paths.dshHome,
      workspace,
      serviceInstalled: installed,
      serviceStarted: started,
    }
  } finally {
    prompts?.close()
  }
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
  const result = await run('npm', ['pack', '--silent', '--pack-destination', packageDir], {
    cwd: paths.packageRoot,
  })
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

interface IdentityCredential {
  apiKey: string
  client: Inkbox
  identity: { id: string; agentHandle: string }
}

async function resolveIdentityCredential(
  apiKey: string | undefined,
  requested: string | undefined,
  prompts?: Prompts,
): Promise<IdentityCredential> {
  if (!apiKey) {
    if (prompts === undefined) throw new Error('INKBOX_API_KEY is required for non-interactive setup')
    const signup = await prompts.confirm('No INKBOX_API_KEY was found. Create a new Inkbox identity?', true)
    if (!signup) throw new Error('Set INKBOX_API_KEY and rerun setup')
    const humanEmail = await prompts.text('Your email address')
    const handle = await prompts.text('Agent handle', 'deepseek-agent')
    const response = await Inkbox.signup({
      humanEmail,
      agentHandle: handle,
      displayName: await prompts.text('Display name', handle),
      noteToHuman: 'Verify this identity to finish DeepSeek Harness setup.',
      harness: 'deepseek-harness',
    })
    process.stdout.write(`Verification was sent to ${response.humanEmail}.\n`)
    const code = await prompts.text('Six-digit verification code')
    await Inkbox.verifySignup(response.apiKey, { verificationCode: code })
    const client = new Inkbox({ apiKey: response.apiKey })
    const identity = await client.getIdentity(response.agentHandle)
    return {
      apiKey: response.apiKey,
      client,
      identity: { id: identity.id, agentHandle: identity.agentHandle },
    }
  }

  const client = new Inkbox({ apiKey })
  const whoami = await client.whoami()
  const identities = await client.listIdentities()
  if (identities.length === 0) throw new Error('This credential cannot access an Inkbox identity')
  let selected = requested ? identities.find((identity) => identity.agentHandle === requested) : undefined
  if (selected === undefined && identities.length === 1) selected = identities[0]
  if (selected === undefined && prompts !== undefined) {
    const index = await prompts.choose(
      'Choose the Inkbox identity for this profile:',
      identities.map((identity) => identity.agentHandle),
    )
    selected = identities[index]
  }
  if (selected === undefined) throw new Error('Select an identity with --identity')

  if (whoami.authType === 'api_key' && whoami.authSubtype === 'api_key.admin_scoped') {
    const scoped = await client.apiKeys.create({
      label: 'DeepSeek Harness',
      description: 'Agent-scoped credential for the DeepSeek Harness integration.',
      scopedIdentityId: selected.id,
    })
    const scopedClient = new Inkbox({ apiKey: scoped.apiKey })
    return {
      apiKey: scoped.apiKey,
      client: scopedClient,
      identity: { id: selected.id, agentHandle: selected.agentHandle },
    }
  }
  return { apiKey, client, identity: { id: selected.id, agentHandle: selected.agentHandle } }
}

async function configureChannels(client: Inkbox, agentHandle: string, prompts: Prompts): Promise<void> {
  const identity = await client.getIdentity(agentHandle)
  if (!identity.imessageEnabled && (await prompts.confirm('Enable shared-line iMessage?', true))) {
    await identity.update({ imessageEnabled: true })
    const triage = await client.imessages.getTriageNumber()
    process.stdout.write(`iMessage is enabled. Message ${triage.number} with ${triage.connectCommand}.\n`)
  }
  const a2a = await identity.a2aSettings().catch(() => undefined)
  if (a2a?.enabled === false && (await prompts.confirm('Enable agent-to-agent communication?', true)))
    await identity.a2aEnable()
  let phoneReady = identity.phoneNumber !== null
  if (
    !phoneReady &&
    (await prompts.confirm('Provision a dedicated phone number for SMS and voice?', false))
  ) {
    const state = (await prompts.text('US state abbreviation', 'NY')).toUpperCase()
    await identity.provisionPhoneNumber({ state })
    phoneReady = true
  }
  if (phoneReady && (await prompts.confirm('Use Inkbox Voice AI for inbound and outbound calls?', true))) {
    await identity.setHostedAgentConfig({})
    await identity.setIncomingCallAction({ incomingCallAction: IncomingCallAction.HOSTED_AGENT })
  }
}
