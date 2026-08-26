import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { type AgentIdentity, CallMode, type CallOrigin, Inkbox, type VoicemailDetection } from '@inkbox/sdk'
import type { ResolvedConfig } from './config.js'

export class InkboxRuntime {
  constructor(
    private readonly ctx: Context,
    readonly config: ResolvedConfig,
  ) {}

  async getClient(): Promise<Inkbox> {
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    if (credential === undefined) {
      throw new Error(
        `Inkbox is not configured. Run "inkbox-deepseek setup" or configure ${this.config.credentialRef} in the selected Harness profile.`,
      )
    }
    return new Inkbox({ apiKey: credential.value })
  }

  async getIdentity(): Promise<AgentIdentity> {
    const client = await this.getClient()
    if (this.config.agentHandle !== undefined) return client.getIdentity(this.config.agentHandle)
    const identities = await client.listIdentities()
    if (identities.length !== 1 || identities[0] === undefined) {
      throw new Error(
        'Inkbox identity is ambiguous. Run setup and select an identity for this Harness profile.',
      )
    }
    return client.getIdentity(identities[0].agentHandle)
  }

  async resolveSigningKey(): Promise<string | undefined> {
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.signingKeyRef))
    return credential?.value
  }

  async resolveRealtimeKey(): Promise<string | undefined> {
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.realtimeCredentialRef))
    return credential?.value
  }

  async placeCall(options: {
    toNumber: string
    reason: string
    origination?: CallOrigin
    voicemailDetection?: VoicemailDetection
  }): Promise<unknown> {
    if (!this.config.voiceEnabled) throw new Error('Phone-call tools are disabled in this profile')
    const identity = await this.getIdentity()
    if (this.config.voiceStack !== 'openai_realtime') {
      return identity.placeCall({
        toNumber: options.toNumber,
        reason: options.reason,
        mode: CallMode.HOSTED_AGENT,
        ...(options.origination ? { origination: options.origination } : {}),
        ...(options.voicemailDetection ? { voicemailDetection: options.voicemailDetection } : {}),
      })
    }
    const publicHost = identity.tunnel?.publicHost
    if (!publicHost) throw new Error('OpenAI Realtime calling requires this identity’s public tunnel')
    const directory = join(this.config.stateDir, 'call-contexts')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await pruneCallContexts(directory)
    const token = randomUUID()
    const contextPath = join(directory, `${token}.json`)
    await writeFile(
      contextPath,
      `${JSON.stringify({ purpose: options.reason, createdAt: new Date().toISOString() })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    )
    try {
      return await identity.placeCall({
        toNumber: options.toNumber,
        mode: CallMode.CLIENT_WEBSOCKET,
        clientWebsocketUrl: `wss://${publicHost}/phone/media/ws?context_token=${token}`,
        ...(options.origination ? { origination: options.origination } : {}),
        ...(options.voicemailDetection ? { voicemailDetection: options.voicemailDetection } : {}),
      })
    } catch (error) {
      await unlink(contextPath).catch(() => {})
      throw error
    }
  }
}

async function pruneCallContexts(directory: string): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000
  const entries = await readdir(directory).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => /^[a-f0-9-]{16,64}\.json$/i.test(entry))
      .map(async (entry) => {
        const path = join(directory, entry)
        const metadata = await stat(path).catch(() => undefined)
        if (metadata && metadata.mtimeMs < cutoff) await unlink(path).catch(() => {})
      }),
  )
}
