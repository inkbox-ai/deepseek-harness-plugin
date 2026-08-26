import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { type AgentIdentity, Inkbox } from '@inkbox/sdk'
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
}
