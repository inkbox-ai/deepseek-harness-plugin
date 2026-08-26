import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('configuration', () => {
  it('uses the Harness home and restart-safe defaults', () => {
    const config = resolveConfig({}, '/tmp/dsh-home')
    expect(config.enabled).toBe(true)
    expect(config.credentialRef).toBe('INKBOX_API_KEY')
    expect(config.signingKeyRef).toBe('INKBOX_WEBHOOK_SIGNING_KEY')
    expect(config.githubWebhookSecretRef).toBe('INKBOX_WEBHOOK_SECRET_GITHUB')
    expect(config.stateDir).toBe('/tmp/dsh-home/inkbox')
    expect(config.batchWindowMs).toBe(750)
    expect(config.permissionTimeoutMs).toBe(600_000)
  })

  it('normalizes workspace and identity without inventing an identity', () => {
    const config = resolveConfig({ workspace: '.', agentHandle: '  agent-one  ' }, '/tmp/dsh')
    expect(config.workspace).toBe(resolve('.'))
    expect(config.agentHandle).toBe('agent-one')
    expect(resolveConfig({ agentHandle: ' ' }, '/tmp/dsh')).not.toHaveProperty('agentHandle')
  })

  it('supports disabling gateway effects while retaining registration', () => {
    const config = resolveConfig({ enabled: false, externalEvents: true, voiceEnabled: false }, '/tmp/dsh')
    expect(config).toMatchObject({ enabled: false, externalEvents: true, voiceEnabled: false })
  })

  it('uses an explicit state directory exactly as configured', () => {
    expect(resolveConfig({ stateDir: '/tmp/custom-state' }, '/tmp/dsh').stateDir).toBe('/tmp/custom-state')
  })
})
