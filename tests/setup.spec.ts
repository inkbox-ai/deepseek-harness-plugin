import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Paths } from '../src/cli/paths.js'
import {
  configureManagedService,
  resolveToolApprovalChoice,
  selectRealtimeCredential,
  waitForGatewayReady,
} from '../src/cli/setup.js'

function paths(home: string): Paths {
  return {
    home,
    dshHome: join(home, '.dsh'),
    runtimeDir: join(home, '.dsh', 'inkbox-runtime'),
    dshBin: join(home, '.dsh', 'inkbox-runtime', 'node_modules', '.bin', 'dsh'),
    localBin: join(home, '.local', 'bin'),
    packageRoot: home,
  }
}

describe('setup credential and liveness behavior', () => {
  it('offers trusted Inkbox tools by default and preserves explicit choices', async () => {
    const confirm = vi.fn(async (_label: string, fallback?: boolean) => fallback ?? false)
    await expect(resolveToolApprovalChoice(undefined, undefined, { confirm })).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith(
      'Allow this agent to run Inkbox tools without asking each time?',
      true,
    )
    await expect(resolveToolApprovalChoice(undefined, false, { confirm })).resolves.toBe(false)
    await expect(resolveToolApprovalChoice(true, false, { confirm })).resolves.toBe(true)
    await expect(resolveToolApprovalChoice(undefined, undefined, undefined)).resolves.toBe(false)
  })

  it('prefers the plugin-specific Realtime credential over OPENAI_API_KEY', () => {
    expect(
      selectRealtimeCredential({
        INKBOX_REALTIME_API_KEY: 'sk-plugin',
        OPENAI_API_KEY: 'sk-general',
      }),
    ).toBe('sk-plugin')
    expect(selectRealtimeCredential({ OPENAI_API_KEY: 'sk-general' })).toBe('sk-general')
  })

  it('supports selecting a named Realtime credential and rejects an empty selection', () => {
    expect(selectRealtimeCredential({ OPENAI_API_KEY_TEAM: 'sk-team' }, 'OPENAI_API_KEY_TEAM')).toBe(
      'sk-team',
    )
    expect(() => selectRealtimeCredential({}, 'OPENAI_API_KEY_TEAM')).toThrow('is not set or is empty')
  })

  it('polls until the started gateway proves process and tunnel readiness', async () => {
    const home = await mkdtemp(join(tmpdir(), 'inkbox-setup-status-'))
    const resolved = paths(home)
    const stateDir = join(resolved.dshHome, 'inkbox')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(resolved.dshHome, 'settings.yaml'), `inkbox:\n  stateDir: ${stateDir}\n`)
    const sleep = vi.fn(async () => {
      await writeFile(
        join(stateDir, 'status.json'),
        JSON.stringify({ ready: true, connected: true, pid: process.pid }),
      )
    })
    expect(await waitForGatewayReady(resolved, 2, sleep)).toBe(true)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('stops polling at the configured liveness timeout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'inkbox-setup-timeout-'))
    const sleep = vi.fn(async () => {})
    expect(await waitForGatewayReady(paths(home), 2, sleep)).toBe(false)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})

describe('managed-service wizard parity', () => {
  it('offers restart for an installed service and claims readiness only after a live status', async () => {
    const manage = vi.fn(async () => 'restarted')
    const result = await configureManagedService(
      paths('/tmp/setup-service'),
      '/tmp/workspace',
      {},
      { confirm: vi.fn(async () => true) },
      {
        isInstalled: vi.fn(async () => true),
        manage,
        waitUntilReady: vi.fn(async () => true),
      },
    )
    expect(manage).toHaveBeenCalledWith('restart', expect.anything(), '/tmp/workspace')
    expect(result).toEqual({ installed: true, started: true, ready: true })
  })

  it('falls back to foreground mode when service installation is unavailable', async () => {
    const result = await configureManagedService(
      paths('/tmp/setup-no-service'),
      '/tmp/workspace',
      { service: true, start: true },
      undefined,
      {
        isInstalled: vi.fn(async () => false),
        manage: vi.fn(async () => {
          throw new Error('service manager unavailable')
        }),
        waitUntilReady: vi.fn(async () => true),
      },
    )
    expect(result).toEqual({ installed: false, started: false, ready: false })
  })

  it('reports a restart failure without failing completed identity setup', async () => {
    const result = await configureManagedService(
      paths('/tmp/setup-restart-failure'),
      '/tmp/workspace',
      { service: true, start: true },
      undefined,
      {
        isInstalled: vi.fn(async () => true),
        manage: vi.fn(async () => {
          throw new Error('restart failed')
        }),
        waitUntilReady: vi.fn(async () => true),
      },
    )
    expect(result).toEqual({ installed: true, started: false, ready: false })
  })
})
