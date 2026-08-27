import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Paths } from './paths.js'
import { run } from './process.js'

export type ServiceAction = 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall'

function quoteSystemd(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function systemdPath(value: string): string {
  return value
    .replaceAll('%', '%%')
    .replace(/[\s\\"']/g, (character) =>
      [...Buffer.from(character)].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join(''),
    )
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export async function manageService(action: ServiceAction, paths: Paths, workspace: string): Promise<string> {
  if (process.platform === 'linux') return manageSystemd(action, paths, workspace)
  if (process.platform === 'darwin') return manageLaunchd(action, paths, workspace)
  throw new Error(
    'Managed service installation currently supports Linux and macOS. Use `inkbox-deepseek run` for foreground mode.',
  )
}

async function manageSystemd(action: ServiceAction, paths: Paths, workspace: string): Promise<string> {
  const unitDir = join(paths.home, '.config', 'systemd', 'user')
  const unit = join(unitDir, 'inkbox-deepseek.service')
  if (action === 'install') {
    await mkdir(unitDir, { recursive: true, mode: 0o700 })
    const content = renderSystemdUnit(paths, workspace)
    await writeFile(unit, content, { encoding: 'utf8', mode: 0o600 })
    await run('systemctl', ['--user', 'daemon-reload'])
    await run('systemctl', ['--user', 'enable', 'inkbox-deepseek.service'])
    return `Installed ${unit}`
  }
  if (action === 'uninstall') {
    await run('systemctl', ['--user', 'disable', '--now', 'inkbox-deepseek.service']).catch(() => {})
    await unlink(unit).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await run('systemctl', ['--user', 'daemon-reload'])
    return 'Removed the Linux user service; profile data and credentials were preserved.'
  }
  const verb = action === 'status' ? 'status' : action
  const result = await run('systemctl', ['--user', verb, 'inkbox-deepseek.service'], {
    stdio: action === 'status' ? 'pipe' : 'inherit',
  })
  return action === 'status' ? result.stdout.trim() : `${action} completed`
}

async function manageLaunchd(action: ServiceAction, paths: Paths, workspace: string): Promise<string> {
  const label = 'ai.inkbox.deepseek'
  const dir = join(paths.home, 'Library', 'LaunchAgents')
  const plist = join(dir, `${label}.plist`)
  const domain = `gui/${process.getuid?.() ?? 0}`
  if (action === 'install') {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const content = renderLaunchdPlist(paths, workspace)
    await writeFile(plist, content, { encoding: 'utf8', mode: 0o600 })
    await run('launchctl', ['bootstrap', domain, plist]).catch(async () => {
      await run('launchctl', ['bootout', domain, plist]).catch(() => {})
      await run('launchctl', ['bootstrap', domain, plist])
    })
    return `Installed ${plist}`
  }
  if (action === 'uninstall') {
    await run('launchctl', ['bootout', domain, plist]).catch(() => {})
    await unlink(plist).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return 'Removed the macOS user service; profile data and credentials were preserved.'
  }
  if (action === 'status') {
    const result = await run('launchctl', ['print', `${domain}/${label}`])
    return result.stdout.trim()
  }
  if (action === 'start') await run('launchctl', ['kickstart', `${domain}/${label}`])
  if (action === 'stop') await run('launchctl', ['kill', 'SIGTERM', `${domain}/${label}`])
  if (action === 'restart') await run('launchctl', ['kickstart', '-k', `${domain}/${label}`])
  return `${action} completed`
}

export async function serviceInstalled(paths: Paths): Promise<boolean> {
  const path =
    process.platform === 'darwin'
      ? join(paths.home, 'Library', 'LaunchAgents', 'ai.inkbox.deepseek.plist')
      : join(paths.home, '.config', 'systemd', 'user', 'inkbox-deepseek.service')
  return readFile(path, 'utf8').then(
    () => true,
    () => false,
  )
}

export function renderSystemdUnit(paths: Paths, workspace: string): string {
  return `[Unit]\nDescription=Inkbox gateway for DeepSeek Harness\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoteSystemd(paths.dshBin)} --profile inkbox\nWorkingDirectory=${systemdPath(workspace)}\nEnvironment=${quoteSystemd(`DSH_HOME=${paths.dshHome}`)}\nEnvironment=${quoteSystemd(`PATH=${process.env.PATH ?? ''}`)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`
}

export function renderLaunchdPlist(paths: Paths, workspace: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>ai.inkbox.deepseek</string>\n<key>ProgramArguments</key><array><string>${xml(paths.dshBin)}</string><string>--profile</string><string>inkbox</string></array>\n<key>WorkingDirectory</key><string>${xml(workspace)}</string>\n<key>EnvironmentVariables</key><dict><key>DSH_HOME</key><string>${xml(paths.dshHome)}</string><key>PATH</key><string>${xml(process.env.PATH ?? '')}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>StandardOutPath</key><string>${xml(join(paths.dshHome, 'inkbox', 'service.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(paths.dshHome, 'inkbox', 'service.error.log'))}</string>\n</dict></plist>\n`
}
