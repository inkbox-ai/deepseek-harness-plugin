import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { type AgentIdentity, CallMode, CallOrigin, VoicemailDetection } from '@inkbox/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { InkboxRuntime } from '../src/runtime.js'

async function harness(stack: ResolvedConfig['voiceStack']) {
  const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-runtime-'))
  const config: ResolvedConfig = {
    enabled: true,
    workspace: stateDir,
    agentHandle: 'deepseek-agent',
    credentialRef: 'INKBOX_API_KEY',
    signingKeyRef: 'INKBOX_WEBHOOK_SIGNING_KEY',
    githubWebhookSecretRef: 'INKBOX_WEBHOOK_SECRET_GITHUB',
    stateDir,
    batchWindowMs: 0,
    permissionTimeoutMs: 1_000,
    autoApproveInkboxTools: false,
    externalEvents: false,
    voiceEnabled: true,
    voiceStack: stack,
    realtimeCredentialRef: 'INKBOX_REALTIME_API_KEY',
    realtimeModel: 'gpt-realtime-2',
    realtimeVoice: 'cedar',
    channelInstructions: {},
  }
  const runtime = new InkboxRuntime({} as Context, config)
  const identity = {
    tunnel: { publicHost: 'deepseek-agent.inkboxwire.com' },
    placeCall: vi.fn(async (options) => ({ id: 'call-1', ...options })),
  } as unknown as AgentIdentity
  vi.spyOn(runtime, 'getIdentity').mockResolvedValue(identity)
  return { runtime, identity, stateDir }
}

describe('configured outbound call routing', () => {
  it('keeps hosted calls server-driven with the reason task brief', async () => {
    const { runtime, identity } = await harness('inkbox_voice_ai')
    await runtime.placeCall({
      toNumber: '+15550000001',
      reason: 'Confirm delivery',
      origination: CallOrigin.DEDICATED_NUMBER,
      voicemailDetection: VoicemailDetection.ENABLED,
    })
    expect(identity.placeCall).toHaveBeenCalledWith({
      toNumber: '+15550000001',
      reason: 'Confirm delivery',
      mode: CallMode.HOSTED_AGENT,
      origination: CallOrigin.DEDICATED_NUMBER,
      voicemailDetection: VoicemailDetection.ENABLED,
    })
  })

  it('uses the identity tunnel for Realtime and never sends hosted-only reason', async () => {
    const { runtime, identity, stateDir } = await harness('openai_realtime')
    await runtime.placeCall({ toNumber: '+15550000001', reason: 'Confirm delivery' })
    expect(identity.placeCall).toHaveBeenCalledWith({
      toNumber: '+15550000001',
      mode: CallMode.CLIENT_WEBSOCKET,
      clientWebsocketUrl: expect.stringMatching(
        /^wss:\/\/deepseek-agent\.inkboxwire\.com\/phone\/media\/ws\?context_token=[a-f0-9-]+$/,
      ),
    })
    const entries = await readdir(join(stateDir, 'call-contexts'))
    expect(entries).toHaveLength(1)
  })

  it('removes one-time call context when call placement fails', async () => {
    const { runtime, identity, stateDir } = await harness('openai_realtime')
    vi.mocked(identity.placeCall).mockRejectedValueOnce(new Error('call rejected'))
    await expect(runtime.placeCall({ toNumber: '+15550000001', reason: 'Confirm delivery' })).rejects.toThrow(
      'call rejected',
    )
    expect(await readdir(join(stateDir, 'call-contexts'))).toEqual([])
  })
})
