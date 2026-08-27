import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Paths } from '../src/cli/paths.js'
import { formatRuntimeStatus, readRuntimeStatus } from '../src/cli/status.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<Paths> {
  const home = await mkdtemp(join(tmpdir(), 'inkbox-deepseek-status-'))
  roots.push(home)
  const dshHome = join(home, '.dsh')
  await mkdir(dshHome, { recursive: true })
  return {
    home,
    dshHome,
    dshBin: join(home, '.local', 'bin', 'dsh'),
    localBin: join(home, '.local', 'bin'),
    packageRoot: home,
  }
}

describe('runtime status', () => {
  it('reads the configured state directory and verifies the process', async () => {
    const paths = await fixture()
    const stateDir = join(paths.home, 'custom-state')
    await mkdir(stateDir)
    await writeFile(join(paths.dshHome, 'settings.yaml'), `inkbox:\n  stateDir: ${stateDir}\n`)
    await writeFile(
      join(stateDir, 'status.json'),
      JSON.stringify({
        ready: true,
        connected: true,
        identity: 'deepseek-agent',
        publicUrl: 'https://agent.example.test',
        pid: process.pid,
        startedAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:01.000Z',
      }),
    )

    const status = await readRuntimeStatus(paths)
    expect(status).toMatchObject({ ready: true, connected: true, processRunning: true })
    expect(formatRuntimeStatus(status)).toContain('Gateway: ready')
  })

  it('reports a stale ready file as stopped', async () => {
    const paths = await fixture()
    const stateDir = join(paths.dshHome, 'inkbox')
    await mkdir(stateDir)
    await writeFile(
      join(stateDir, 'status.json'),
      JSON.stringify({ ready: true, connected: true, identity: 'deepseek-agent', pid: 2_147_483_647 }),
    )

    const status = await readRuntimeStatus(paths)
    expect(status.processRunning).toBe(false)
    expect(formatRuntimeStatus(status)).toContain('Gateway: stopped')
  })
})
