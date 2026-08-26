import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { PROFILE_NAME } from '../constants.js'
import type { Paths } from './paths.js'

export type LauncherResult =
  | { installed: true; path: string; onPath: boolean }
  | { installed: false; path: string; reason: string }

export async function installLauncher(paths: Paths): Promise<LauncherResult> {
  const launcher = join(paths.localBin, 'inkbox-deepseek')
  const target = join(paths.dshHome, 'profiles', PROFILE_NAME, 'node_modules', '.bin', 'inkbox-deepseek')
  await mkdir(paths.localBin, { recursive: true, mode: 0o755 })
  try {
    const existing = await lstat(launcher)
    if (!existing.isSymbolicLink()) {
      return { installed: false, path: launcher, reason: 'A non-symlink file already exists there' }
    }
    const current = await readlink(launcher)
    const resolved = resolve(paths.localBin, current)
    if (resolved === target) return { installed: true, path: launcher, onPath: pathContains(paths.localBin) }
    const ownedSuffix = join('profiles', PROFILE_NAME, 'node_modules', '.bin', 'inkbox-deepseek')
    if (!resolved.endsWith(ownedSuffix)) {
      return { installed: false, path: launcher, reason: 'An unrelated symlink already exists there' }
    }
    await unlink(launcher)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await symlink(target, launcher)
  return { installed: true, path: launcher, onPath: pathContains(paths.localBin) }
}

function pathContains(directory: string): boolean {
  return (process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .some((entry) => entry.length > 0 && resolve(entry) === resolve(directory) && isAbsolute(resolve(entry)))
}
