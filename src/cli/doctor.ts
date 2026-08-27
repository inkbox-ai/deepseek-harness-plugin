import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Inkbox } from '@inkbox/sdk'
import { readYaml } from './files.js'
import { validateHarness } from './harness.js'
import type { Paths } from './paths.js'
import { run } from './process.js'
import { manageService, serviceInstalled } from './service.js'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export async function doctor(paths: Paths): Promise<Check[]> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail })
  }
  add('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.version)

  let harnessReady = false
  try {
    const version = await validateHarness(paths)
    harnessReady = true
    add('DeepSeek Harness', true, `${version} at ${paths.dshBin}`)
  } catch (error) {
    add('DeepSeek Harness', false, error instanceof Error ? error.message : String(error))
  }

  const profileManifest = join(paths.dshHome, 'profiles', 'inkbox', 'package.json')
  try {
    const manifest = JSON.parse(await readFile(profileManifest, 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    const bundled = manifest.dsh?.profile?.bundles?.includes('@inkbox/deepseek-harness-plugin') === true
    add(
      'Inkbox bundle',
      bundled,
      bundled ? 'Installed in profile inkbox' : 'Bundle is missing from profile inkbox',
    )
  } catch {
    add('Inkbox bundle', false, 'Profile inkbox is not initialized')
  }

  const settings = await readYaml(join(paths.dshHome, 'settings.yaml'))
  const section = settings?.inkbox as Record<string, unknown> | undefined
  const agentHandle = typeof section?.agentHandle === 'string' ? section.agentHandle : undefined
  const voiceStack = section?.voiceStack === 'openai_realtime' ? 'openai_realtime' : 'inkbox_voice_ai'
  add(
    'Profile settings',
    agentHandle !== undefined,
    agentHandle ? `Identity ${agentHandle}` : 'Missing inkbox.agentHandle',
  )

  const credentials = await readYaml(join(paths.dshHome, '.credentials.yaml'))
  const refs = credentials?.refs as Record<string, unknown> | undefined
  const inkboxKey =
    typeof refs?.INKBOX_API_KEY === 'string' ? refs.INKBOX_API_KEY : process.env.INKBOX_API_KEY
  const deepseekKey =
    typeof refs?.DEEPSEEK_API_KEY === 'string' ? refs.DEEPSEEK_API_KEY : process.env.DEEPSEEK_API_KEY
  add('DeepSeek credential', Boolean(deepseekKey), deepseekKey ? 'Configured' : 'Missing DEEPSEEK_API_KEY')
  add('Inkbox credential', Boolean(inkboxKey), inkboxKey ? 'Configured' : 'Missing INKBOX_API_KEY')
  const realtimeKey =
    typeof refs?.INKBOX_REALTIME_API_KEY === 'string'
      ? refs.INKBOX_REALTIME_API_KEY
      : (process.env.INKBOX_REALTIME_API_KEY ?? process.env.OPENAI_API_KEY)
  if (voiceStack === 'openai_realtime')
    add(
      'OpenAI Realtime credential',
      Boolean(realtimeKey),
      realtimeKey ? 'Configured' : 'Missing INKBOX_REALTIME_API_KEY',
    )

  if (inkboxKey && agentHandle) {
    try {
      const client = new Inkbox({ apiKey: inkboxKey })
      const whoami = await client.whoami()
      const identity = await client.getIdentity(agentHandle)
      add(
        'Inkbox authentication',
        true,
        `${whoami.authSubtype ?? whoami.authType}; ${identity.emailAddress ?? identity.agentHandle}`,
      )
      add('Tunnel resource', identity.tunnel !== null, identity.tunnel ? 'Provisioned' : 'Missing')
      add('Email channel', identity.mailbox !== null, identity.emailAddress ?? 'Missing mailbox')
      add(
        'SMS/voice channel',
        identity.phoneNumber !== null,
        identity.phoneNumber
          ? 'Dedicated number provisioned'
          : 'Optional dedicated number is not provisioned',
      )
      add(
        'iMessage channel',
        identity.imessageEnabled,
        identity.imessageEnabled ? 'Enabled' : 'Optional channel is disabled',
      )
      if (identity.phoneNumber) {
        const incoming = await identity.getIncomingCallAction()
        const expected = voiceStack === 'openai_realtime' ? 'auto_accept' : 'hosted_agent'
        add(
          'Call handling',
          incoming.incomingCallAction === expected,
          incoming.incomingCallAction === expected
            ? voiceStack === 'openai_realtime'
              ? 'OpenAI Realtime'
              : 'Inkbox hosted agent'
            : `Expected ${expected}; found ${incoming.incomingCallAction}`,
        )
      }
      const signingConfigured = (await identity.getSigningKeyStatus()).configured
      const signingStored = typeof refs?.INKBOX_WEBHOOK_SIGNING_KEY === 'string'
      add(
        'Webhook signing',
        signingConfigured && signingStored,
        signingConfigured
          ? signingStored
            ? 'Configured'
            : 'Signing key exists but is unavailable to this profile'
          : 'Will be created on first gateway start',
      )
    } catch (error) {
      add('Inkbox authentication', false, error instanceof Error ? error.message : String(error))
    }
  }

  if (!harnessReady) add('Harness composition', false, 'DeepSeek Harness is unavailable')
  else
    try {
      await run(paths.dshBin, ['--profile', 'inkbox', '--dump-config'], {
        env: { ...process.env, DSH_HOME: paths.dshHome },
      })
      add('Harness composition', true, 'Profile composes successfully')
    } catch (error) {
      add('Harness composition', false, error instanceof Error ? error.message : String(error))
    }

  const installed = await serviceInstalled(paths)
  if (!installed) add('Managed service', true, 'Not installed; foreground mode is available')
  else {
    try {
      const status = await manageService(
        'status',
        paths,
        typeof section?.workspace === 'string' ? section.workspace : process.cwd(),
      )
      add('Managed service', true, /active|running|state = running/i.test(status) ? 'Running' : 'Installed')
    } catch (error) {
      add('Managed service', false, error instanceof Error ? error.message : String(error))
    }
  }

  for (const check of checks) process.stdout.write(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}\n`)
  const requiredFailures = checks.filter(
    (check) =>
      !check.ok &&
      !['SMS/voice channel', 'iMessage channel', 'Managed service', 'Webhook signing'].includes(check.name),
  )
  if (requiredFailures.length > 0) process.exitCode = 1
  return checks
}
