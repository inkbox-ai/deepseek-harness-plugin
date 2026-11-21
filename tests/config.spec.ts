import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(config.autoApproveInkboxTools).toBe(false)
    expect(config.voiceStack).toBe('inkbox_voice_ai')
    expect(config.realtimeCredentialRef).toBe('INKBOX_REALTIME_API_KEY')
    expect(config.realtimeModel).toBe('gpt-realtime-2')
    expect(config.realtimeVoice).toBe('cedar')
    expect(config.channelInstructions).toEqual({})
    expect(config.slackEnabled).toBe(false)
    expect(resolveConfig({ slackEnabled: true }, '/tmp/dsh-home').slackEnabled).toBe(true)
  })

  it('normalizes workspace and identity without inventing an identity', () => {
    const config = resolveConfig({ workspace: '.', agentHandle: '  agent-one  ' }, '/tmp/dsh')
    expect(config.workspace).toBe(resolve('.'))
    expect(config.agentHandle).toBe('agent-one')
    expect(resolveConfig({ agentHandle: ' ' }, '/tmp/dsh')).not.toHaveProperty('agentHandle')
  })

  it('supports disabling gateway effects while retaining registration', () => {
    const config = resolveConfig(
      { enabled: false, externalEvents: true, voiceEnabled: false, autoApproveInkboxTools: true },
      '/tmp/dsh',
    )
    expect(config).toMatchObject({
      enabled: false,
      externalEvents: true,
      voiceEnabled: false,
      autoApproveInkboxTools: true,
    })
  })

  it('uses an explicit state directory exactly as configured', () => {
    expect(resolveConfig({ stateDir: '/tmp/custom-state' }, '/tmp/dsh').stateDir).toBe('/tmp/custom-state')
  })

  it('preserves channel and contact-specific instructions', () => {
    expect(
      resolveConfig(
        {
          channelInstructions: {
            sms: 'Keep it brief.',
            'contact-1': 'Use the agreed status format.',
          },
        },
        '/tmp/dsh',
      ).channelInstructions,
    ).toEqual({ sms: 'Keep it brief.', 'contact-1': 'Use the agreed status format.' })
  })

  describe('Slack enablement from the environment', () => {
    afterEach(() => vi.unstubAllEnvs())
    // The managed host builds its configuration without slackEnabled.
    const hosted = () =>
      resolveConfig(
        {
          agentHandle: 'hosted-agent',
          workspace: '/home/agent',
          signingKeyRef: 'INKBOX_SIGNING_KEY',
          stateDir: '/tmp/hosted-state',
          autoApproveInkboxTools: false,
          externalEvents: false,
          voiceStack: 'inkbox_voice_ai',
          channelInstructions: { default: '' },
        },
        '/tmp/dsh',
      )

    it('enables Slack for a host that sets INKBOX_SLACK_ENABLED', () => {
      vi.stubEnv('INKBOX_SLACK_ENABLED', 'true')
      expect(hosted().slackEnabled).toBe(true)
      vi.stubEnv('INKBOX_SLACK_ENABLED', ' 1 ')
      expect(hosted().slackEnabled).toBe(true)
      vi.stubEnv('INKBOX_SLACK_ENABLED', 'false')
      expect(hosted().slackEnabled).toBe(false)
      vi.stubEnv('INKBOX_SLACK_ENABLED', 'maybe')
      expect(hosted().slackEnabled).toBe(false)
    })

    it('keeps an explicit profile setting over the environment', () => {
      vi.stubEnv('INKBOX_SLACK_ENABLED', 'true')
      expect(resolveConfig({ slackEnabled: false }, '/tmp/dsh').slackEnabled).toBe(false)
      vi.stubEnv('INKBOX_SLACK_ENABLED', 'false')
      expect(resolveConfig({ slackEnabled: true }, '/tmp/dsh').slackEnabled).toBe(true)
    })
  })
})
