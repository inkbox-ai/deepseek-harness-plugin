import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostedDiagnostics } from '../src/hosted-diagnostics.js'

let directory: string
let path: string
let value: Record<string, unknown>
let env: NodeJS.ProcessEnv
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'doctor-'))
  path = join(directory, 'status.json')
  env = { INKBOX_HOSTED_MODE: '1', INKBOX_DIAGNOSTIC_CONTEXT: 'terminal', INKBOX_DIAGNOSTICS_FILE: path }
  value = {
    version: 1,
    identity: 'example',
    harness: 'deepseek',
    pid: process.pid,
    observed_at: Date.now() / 1000,
    ready: true,
    signing_key_configured: true,
  }
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
describe('managed diagnostics', () => {
  it('checks runtime health without exposing a key to the terminal', () => {
    expect(hostedDiagnostics('@example', 'deepseek', undefined, env)?.ready).toBe(true)
  })
  it.each([
    { ready: false },
    { signing_key_configured: false },
    { observed_at: 1 },
    { observed_at: Date.now() / 1000 + 3600 },
    { identity: 'other' },
    { harness: 'other' },
    { pid: -1 },
    { ready: 'true' },
    { version: 2 },
  ])('rejects unhealthy or mismatched evidence %j', (update) => {
    writeFileSync(path, JSON.stringify({ ...value, ...update }))
    expect(hostedDiagnostics('example', 'deepseek', undefined, env)?.ready).toBe(false)
  })
  it('reports unavailable status without leaking file contents', () => {
    writeFileSync(path, 'private invalid payload')
    const result = hostedDiagnostics('example', 'deepseek', undefined, env)
    expect(result?.ready).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private invalid payload')
    rmSync(path)
    expect(hostedDiagnostics('example', 'deepseek', undefined, env)?.ready).toBe(false)
  })
  it('rejects reports readable by other users', () => {
    chmodSync(path, 0o644)
    expect(hostedDiagnostics('example', 'deepseek', undefined, env)?.ready).toBe(false)
  })
  it('still requires a signing key in the runtime context', () => {
    env.INKBOX_DIAGNOSTIC_CONTEXT = 'runtime'
    expect(hostedDiagnostics('example', 'deepseek', undefined, env)?.ready).toBe(false)
    expect(hostedDiagnostics('example', 'deepseek', 'synthetic', env)?.ready).toBe(true)
  })
  it('leaves standalone diagnostics unchanged', () => {
    delete env.INKBOX_HOSTED_MODE
    expect(hostedDiagnostics('example', 'deepseek', undefined, env)).toBeNull()
  })
})

it('doctor uses runtime evidence without requiring a standalone profile', async () => {
  const { doctor } = await import('../src/cli/doctor.js')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  vi.stubEnv('INKBOX_IDENTITY', 'example')
  try {
    const checks = await doctor({} as Parameters<typeof doctor>[0])
    expect(checks.every((check) => check.ok)).toBe(true)
  } finally {
    vi.unstubAllEnvs()
  }
})
