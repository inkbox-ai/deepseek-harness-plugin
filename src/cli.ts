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
  .option('--non-interactive', 'read credentials and choices from flags and environment')
  .option('--install-service', 'install the managed service')
  .option('--skip-service', 'do not install the managed service')
  .option('--start', 'start or restart the service after setup')
  .action(async (options) => {
    if (options.installService && options.skipService)
      throw new Error('Choose only one of --install-service or --skip-service')
    await setup(resolvePaths(), {
      ...(options.identity ? { identity: options.identity as string } : {}),
      ...(options.workspace ? { workspace: options.workspace as string } : {}),
      ...(options.pluginSpec ? { pluginSpec: options.pluginSpec as string } : {}),
      ...(options.inkboxKeyEnv ? { inkboxKeyEnv: options.inkboxKeyEnv as string } : {}),
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
