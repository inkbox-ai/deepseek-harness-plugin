import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SUPPORTED_DSH_VERSION, validateHarness } from '../src/cli/harness.js'
import type { SetupPrompts } from '../src/cli/onboarding.js'
import type { Paths } from '../src/cli/paths.js'
import {
  configureManagedService,
  printSummary,
  resolveDeepSeekCredential,
  resolveToolApprovalChoice,
  selectInkboxCredential,
  selectRealtimeCredential,
  waitForGatewayReady,
} from '../src/cli/setup.js'

function paths(home: string): Paths {
  return {
    home,
    dshHome: join(home, '.dsh'),
    dshBin: join(home, '.local', 'bin', 'dsh'),
    localBin: join(home, '.local', 'bin'),
    packageRoot: home,
  }
}

describe('setup credential and liveness behavior', () => {
  it('requires the supported installed DeepSeek Harness', async () => {
    const execute = vi.fn(async () => ({ stdout: `${SUPPORTED_DSH_VERSION}\n`, stderr: '' }))
    await expect(validateHarness(paths('/tmp/harness-installed'), execute)).resolves.toBe(
      SUPPORTED_DSH_VERSION,
    )
    expect(execute).toHaveBeenCalledWith(
      '/tmp/harness-installed/.local/bin/dsh',
      ['--version'],
      expect.objectContaining({ env: expect.objectContaining({ DSH_HOME: '/tmp/harness-installed/.dsh' }) }),
    )
  })

  it('rejects a missing or incompatible DeepSeek Harness', async () => {
    await expect(
      validateHarness(
        paths('/tmp/harness-missing'),
        vi.fn(async () => Promise.reject(new Error('ENOENT'))),
      ),
    ).rejects.toThrow('was not found on PATH')
    await expect(
      validateHarness(
        paths('/tmp/harness-old'),
        vi.fn(async () => ({ stdout: '0.1.0\n', stderr: '' })),
      ),
    ).rejects.toThrow(`DeepSeek Harness ${SUPPORTED_DSH_VERSION} is required; found 0.1.0`)
  })

  it('reuses a DeepSeek credential already configured in the Harness home', () => {
    expect(resolveDeepSeekCredential({}, { DEEPSEEK_API_KEY: 'saved-key' })).toBe('saved-key')
    expect(
      resolveDeepSeekCredential({ DEEPSEEK_API_KEY: 'environment-key' }, { DEEPSEEK_API_KEY: 'saved-key' }),
    ).toBe('environment-key')
  })

  it('uses self-signup by default instead of enumerating environment credentials', async () => {
    const confirm = vi.fn(async () => false)
    const secret = vi.fn(async () => 'ApiKey_pasted')
    await expect(
      selectInkboxCredential({ INKBOX_API_KEY_FIRST: 'first', INKBOX_API_KEY_SECOND: 'second' }, undefined, {
        confirm,
        secret,
      }),
    ).resolves.toBeUndefined()
    expect(confirm).toHaveBeenCalledWith('Do you already have an Inkbox API key?', false)
    expect(secret).not.toHaveBeenCalled()
  })

  it('securely asks for a key only after the user chooses bring-your-own-key', async () => {
    const confirm = vi.fn(async () => true)
    const secret = vi.fn(async () => '  ApiKey_pasted  ')
    await expect(selectInkboxCredential({}, undefined, { confirm, secret })).resolves.toBe('ApiKey_pasted')
    expect(secret).toHaveBeenCalledWith('Paste your Inkbox API key (ApiKey_...)')
  })

  it('offers trusted Inkbox tools by default and preserves explicit choices', async () => {
    const confirm = vi.fn(async (_label: string, fallback?: boolean) => fallback ?? false)
    const prompt = { confirm } as unknown as SetupPrompts
    await expect(resolveToolApprovalChoice(undefined, undefined, prompt)).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    await expect(resolveToolApprovalChoice(undefined, false, prompt)).resolves.toBe(false)
    await expect(resolveToolApprovalChoice(true, false, prompt)).resolves.toBe(true)
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
  it('does not claim setup completed when the gateway failed readiness', () => {
    const output: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    try {
      printSummary(
        { agentHandle: 'deepseek-agent', emailAddress: 'deepseek-agent@example.test' },
        'inkbox_voice_ai',
        paths('/tmp/setup-not-ready'),
        true,
        false,
      )
    } finally {
      write.mockRestore()
    }
    expect(output.join('')).toContain('Setup saved for deepseek-agent, but the gateway is not ready.')
    expect(output.join('')).not.toContain('Setup complete')
  })

  it('leaves a running gateway live when restart is declined', async () => {
    const manage = vi.fn(async () => 'restarted')
    const confirm = vi.fn(async () => false)
    const result = await configureManagedService(
      paths('/tmp/setup-live'),
      '/tmp/workspace',
      {},
      { confirm },
      {
        isInstalled: vi.fn(async () => true),
        isRunning: vi.fn(async () => true),
        manage,
        waitUntilReady: vi.fn(async () => true),
      },
    )
    expect(confirm).toHaveBeenCalledWith('Restart the running gateway now?', true)
    expect(manage).not.toHaveBeenCalled()
    expect(result).toEqual({ installed: true, started: true, ready: true })
  })

  it('offers restart for an installed service and claims readiness only after a live status', async () => {
    const manage = vi.fn(
      async (_action: 'install' | 'restart', _paths: Paths, _workspace: string) => 'restarted',
    )
    const result = await configureManagedService(
      paths('/tmp/setup-service'),
      '/tmp/workspace',
      {},
      { confirm: vi.fn(async () => true) },
      {
        isInstalled: vi.fn(async () => true),
        isRunning: vi.fn(async () => true),
        manage,
        waitUntilReady: vi.fn(async () => true),
      },
    )
    expect(manage.mock.calls.map(([action]) => action)).toEqual(['install', 'restart'])
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
        isRunning: vi.fn(async () => false),
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
        isRunning: vi.fn(async () => false),
        manage: vi.fn(async () => {
          throw new Error('restart failed')
        }),
        waitUntilReady: vi.fn(async () => true),
      },
    )
    expect(result).toEqual({ installed: true, started: false, ready: false })
  })
})
