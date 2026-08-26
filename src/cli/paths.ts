import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Paths {
  home: string
  dshHome: string
  runtimeDir: string
  dshBin: string
  localBin: string
  packageRoot: string
}

export function resolvePaths(): Paths {
  const home = resolve(process.env.HOME ?? process.cwd())
  const dshHome = resolve(process.env.DSH_HOME ?? join(home, '.dsh'))
  const runtimeDir = join(dshHome, 'inkbox-runtime')
  const binName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  return {
    home,
    dshHome,
    runtimeDir,
    dshBin: join(runtimeDir, 'node_modules', '.bin', binName),
    localBin: join(home, '.local', 'bin'),
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  }
}
