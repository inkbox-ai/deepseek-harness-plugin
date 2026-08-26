import { lstat, mkdtemp, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installLauncher } from '../src/cli/launcher.js'
import type { Paths } from '../src/cli/paths.js'

async function paths(): Promise<Paths> {
  const home = await mkdtemp(join(tmpdir(), 'inkbox-launcher-'))
  const dshHome = join(home, '.dsh')
  return {
    home,
    dshHome,
    runtimeDir: join(dshHome, 'inkbox-runtime'),
    dshBin: join(dshHome, 'inkbox-runtime', 'node_modules', '.bin', 'dsh'),
    localBin: join(home, '.local', 'bin'),
    packageRoot: '/plugin',
  }
}

describe('persistent CLI launcher', () => {
  it('links the user command to the profile-installed CLI', async () => {
    const fixture = await paths()
    const result = await installLauncher(fixture)
    expect(result.installed).toBe(true)
    const launcher = join(fixture.localBin, 'inkbox-deepseek')
    expect((await lstat(launcher)).isSymbolicLink()).toBe(true)
    expect(await readlink(launcher)).toBe(
      join(fixture.dshHome, 'profiles', 'inkbox', 'node_modules', '.bin', 'inkbox-deepseek'),
    )
  })

  it('is idempotent when rerun', async () => {
    const fixture = await paths()
    await installLauncher(fixture)
    await expect(installLauncher(fixture)).resolves.toMatchObject({ installed: true })
  })

  it('does not overwrite an unrelated user command', async () => {
    const fixture = await paths()
    await writeFile(join(fixture.home, 'occupied'), 'keep')
    await installLauncher(fixture)
    const launcher = join(fixture.localBin, 'inkbox-deepseek')
    const { unlink } = await import('node:fs/promises')
    await unlink(launcher)
    await writeFile(launcher, 'keep')
    await expect(installLauncher(fixture)).resolves.toMatchObject({
      installed: false,
      reason: expect.stringContaining('non-symlink'),
    })
    expect(await lstat(launcher)).toBeDefined()
  })
})
