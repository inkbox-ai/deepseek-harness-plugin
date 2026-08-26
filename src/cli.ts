#!/usr/bin/env node
import { Command } from 'commander'
import { doctor } from './cli/doctor.js'
import { resolvePaths } from './cli/paths.js'
import { run } from './cli/process.js'
import { manageService, type ServiceAction } from './cli/service.js'
import { setup } from './cli/setup.js'
import { formatRuntimeStatus, readRuntimeStatus } from './cli/status.js'
import { PLUGIN_VERSION } from './constants.js'

const program = new Command()
  .name('inkbox-deepseek')
  .description('Install and operate Inkbox for DeepSeek Harness.')
  .version(PLUGIN_VERSION)

program
  .command('setup')
  .description('Install the Inkbox bundle and run the setup wizard.')
  .option('--identity <handle>', 'select an existing Inkbox identity')
  .option('--workspace <path>', 'workspace used by channel sessions')
  .option('--plugin-spec <spec>', 'package or local path installed into the Harness profile')
  .option('--inkbox-key-env <name>', 'environment variable containing the Inkbox API key')
  .option('--realtime-key-env <name>', 'environment variable containing the OpenAI Realtime API key')
  .option('--voice-stack <stack>', 'phone-call handling: inkbox_voice_ai or openai_realtime')
  .option('--realtime-model <model>', 'OpenAI Realtime model')
  .option('--realtime-voice <voice>', 'OpenAI Realtime voice')
  .option('--auto-approve-inkbox-tools', 'run Inkbox tools without per-call approval prompts')
  .option('--ask-inkbox-tool-approvals', 'ask before each mutating Inkbox tool call')
  .option('--hosted-authority <mode>', 'hosted-agent authority: contact_scoped or yolo')
  .option('--rotate-signing-key', 'rotate the identity webhook signing key')
  .option('--enable-imessage', 'enable shared-line iMessage')
  .option('--skip-imessage', 'do not change iMessage configuration')
  .option('--enable-a2a', 'enable agent-to-agent communication')
  .option('--skip-a2a', 'do not change agent-to-agent communication')
  .option('--provision-phone', 'provision a dedicated phone number')
  .option('--skip-phone', 'do not provision a dedicated phone number')
  .option('--phone-state <state>', 'two-letter US state for phone provisioning')
  .option('--non-interactive', 'read credentials and choices from flags and environment')
  .option('--install-service', 'install the managed service')
  .option('--skip-service', 'do not install the managed service')
  .option('--start', 'start or restart the service after setup')
  .action(async (options) => {
    if (options.installService && options.skipService)
      throw new Error('Choose only one of --install-service or --skip-service')
    if (options.enableImessage && options.skipImessage)
      throw new Error('Choose only one of --enable-imessage or --skip-imessage')
    if (options.enableA2a && options.skipA2a) throw new Error('Choose only one of --enable-a2a or --skip-a2a')
    if (options.provisionPhone && options.skipPhone)
      throw new Error('Choose only one of --provision-phone or --skip-phone')
    if (options.autoApproveInkboxTools && options.askInkboxToolApprovals)
      throw new Error('Choose only one of --auto-approve-inkbox-tools or --ask-inkbox-tool-approvals')
    if (options.voiceStack && !['inkbox_voice_ai', 'openai_realtime'].includes(options.voiceStack))
      throw new Error('--voice-stack must be inkbox_voice_ai or openai_realtime')
    if (options.hostedAuthority && !['contact_scoped', 'yolo'].includes(options.hostedAuthority))
      throw new Error('--hosted-authority must be contact_scoped or yolo')
    await setup(resolvePaths(), {
      ...(options.identity ? { identity: options.identity as string } : {}),
      ...(options.workspace ? { workspace: options.workspace as string } : {}),
      ...(options.pluginSpec ? { pluginSpec: options.pluginSpec as string } : {}),
      ...(options.inkboxKeyEnv ? { inkboxKeyEnv: options.inkboxKeyEnv as string } : {}),
      ...(options.realtimeKeyEnv ? { realtimeKeyEnv: options.realtimeKeyEnv as string } : {}),
      ...(options.voiceStack
        ? { voiceStack: options.voiceStack as 'inkbox_voice_ai' | 'openai_realtime' }
        : {}),
      ...(options.realtimeModel ? { realtimeModel: options.realtimeModel as string } : {}),
      ...(options.realtimeVoice ? { realtimeVoice: options.realtimeVoice as string } : {}),
      ...(options.autoApproveInkboxTools
        ? { autoApproveInkboxTools: true }
        : options.askInkboxToolApprovals
          ? { autoApproveInkboxTools: false }
          : {}),
      ...(options.hostedAuthority
        ? { hostedAuthority: options.hostedAuthority as 'contact_scoped' | 'yolo' }
        : {}),
      rotateSigningKey: Boolean(options.rotateSigningKey),
      ...(options.enableImessage
        ? { enableIMessage: true }
        : options.skipImessage
          ? { enableIMessage: false }
          : {}),
      ...(options.enableA2a ? { enableA2A: true } : options.skipA2a ? { enableA2A: false } : {}),
      ...(options.provisionPhone
        ? { provisionPhone: true }
        : options.skipPhone
          ? { provisionPhone: false }
          : {}),
      ...(options.phoneState ? { phoneState: options.phoneState as string } : {}),
      nonInteractive: Boolean(options.nonInteractive),
      ...(options.installService ? { service: true } : options.skipService ? { service: false } : {}),
      ...(options.start ? { start: true } : {}),
    })
  })

program
  .command('doctor')
  .description('Check the profile, credentials, identity, channels, composition, and service.')
  .action(async () => {
    await doctor(resolvePaths())
  })

program
  .command('status')
  .description('Show gateway readiness, identity, tunnel, and process state.')
  .option('--json', 'print machine-readable JSON')
  .action(async (options) => {
    const status = await readRuntimeStatus(resolvePaths())
    process.stdout.write(`${options.json ? JSON.stringify(status, null, 2) : formatRuntimeStatus(status)}\n`)
  })

program
  .command('run')
  .description('Run the Inkbox Harness profile in the foreground.')
  .allowUnknownOption(true)
  .argument('[args...]')
  .action(async (args: string[]) => {
    const paths = resolvePaths()
    await run(paths.dshBin, ['--profile', 'inkbox', ...args], {
      env: { ...process.env, DSH_HOME: paths.dshHome },
      stdio: 'inherit',
    })
  })

const service = program.command('service').description('Manage the Linux or macOS user service.')
for (const action of ['install', 'start', 'stop', 'restart', 'status', 'uninstall'] as const) {
  service.command(action).action(async () => {
    const paths = resolvePaths()
    const settingsPath = `${paths.dshHome}/settings.yaml`
    let workspace = process.cwd()
    try {
      const { parse } = await import('yaml')
      const { readFile } = await import('node:fs/promises')
      const settings = parse(await readFile(settingsPath, 'utf8')) as { inkbox?: { workspace?: string } }
      if (settings.inkbox?.workspace) workspace = settings.inkbox.workspace
    } catch {}
    process.stdout.write(`${await manageService(action as ServiceAction, paths, workspace)}\n`)
  })
}

program
  .command('profile')
  .description('Print the selected Harness profile name.')
  .action(() => {
    process.stdout.write('inkbox\n')
  })

program.parseAsync().catch((error) => {
  process.stderr.write(`inkbox-deepseek: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
