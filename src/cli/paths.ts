import { accessSync, constants } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Paths {
  home: string
  dshHome: string
  dshBin: string
  localBin: string
  packageRoot: string
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = resolve(env.INKBOX_DEEPSEEK_USER_HOME ?? env.HOME ?? process.cwd())
  const dshHome = resolve(env.DSH_HOME ?? join(home, '.dsh'))
  return {
    home,
    dshHome,
    dshBin: findExecutable('dsh', env),
    localBin: join(home, '.local', 'bin'),
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  }
}

export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return resolve(command)
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`)
      try {
        accessSync(candidate, constants.X_OK)
        return resolve(candidate)
      } catch {}
    }
  }
  return command
}
