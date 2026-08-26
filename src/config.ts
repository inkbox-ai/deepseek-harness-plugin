import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BATCH_WINDOW_MS, DEFAULT_PERMISSION_TIMEOUT_MS, INKBOX_CREDENTIAL_REF } from './constants.js'

export interface Config {
  enabled?: boolean
  workspace?: string
  agentHandle?: string
  credentialRef?: string
  signingKeyRef?: string
  githubWebhookSecretRef?: string
  stateDir?: string
  batchWindowMs?: number
  permissionTimeoutMs?: number
  autoApproveInkboxTools?: boolean
  externalEvents?: boolean
  voiceEnabled?: boolean
  voiceStack?: VoiceStack
  realtimeCredentialRef?: string
  realtimeModel?: string
  realtimeVoice?: string
  channelInstructions?: Record<string, string>
}

export type VoiceStack = 'inkbox_voice_ai' | 'openai_realtime'

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  workspace: z.string().default(process.cwd()),
  agentHandle: z.string(),
  credentialRef: z.string().default(INKBOX_CREDENTIAL_REF),
  signingKeyRef: z.string().default('INKBOX_WEBHOOK_SIGNING_KEY'),
  githubWebhookSecretRef: z.string().default('INKBOX_WEBHOOK_SECRET_GITHUB'),
  stateDir: z.string(),
  batchWindowMs: z.number().step(1).min(0).max(30_000).default(DEFAULT_BATCH_WINDOW_MS),
  permissionTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(DEFAULT_PERMISSION_TIMEOUT_MS),
  autoApproveInkboxTools: z.boolean().default(false),
  externalEvents: z.boolean().default(false),
  voiceEnabled: z.boolean().default(true),
  voiceStack: z.union(['inkbox_voice_ai', 'openai_realtime']).default('inkbox_voice_ai'),
  realtimeCredentialRef: z.string().default('INKBOX_REALTIME_API_KEY'),
  realtimeModel: z.string().default('gpt-realtime-2'),
  realtimeVoice: z.string().default('cedar'),
  channelInstructions: z.dict(z.string()).default({}),
})

export interface ResolvedConfig {
  enabled: boolean
  workspace: string
  agentHandle?: string
  credentialRef: string
  signingKeyRef: string
  githubWebhookSecretRef: string
  stateDir: string
  batchWindowMs: number
  permissionTimeoutMs: number
  autoApproveInkboxTools: boolean
  externalEvents: boolean
  voiceEnabled: boolean
  voiceStack: VoiceStack
  realtimeCredentialRef: string
  realtimeModel: string
  realtimeVoice: string
  channelInstructions: Record<string, string>
}

export function resolveConfig(config: Config, harnessHome = process.env.DSH_HOME): ResolvedConfig {
  const root = harnessHome ? resolve(harnessHome) : resolve(process.env.HOME ?? process.cwd(), '.dsh')
  return {
    enabled: config.enabled ?? true,
    workspace: resolve(config.workspace ?? process.cwd()),
    ...(config.agentHandle?.trim() ? { agentHandle: config.agentHandle.trim() } : {}),
    credentialRef: config.credentialRef?.trim() || INKBOX_CREDENTIAL_REF,
    signingKeyRef: config.signingKeyRef?.trim() || 'INKBOX_WEBHOOK_SIGNING_KEY',
    githubWebhookSecretRef: config.githubWebhookSecretRef?.trim() || 'INKBOX_WEBHOOK_SECRET_GITHUB',
    stateDir: config.stateDir ? resolve(config.stateDir) : resolve(root, 'inkbox'),
    batchWindowMs: config.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    permissionTimeoutMs: config.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    autoApproveInkboxTools: config.autoApproveInkboxTools ?? false,
    externalEvents: config.externalEvents ?? false,
    voiceEnabled: config.voiceEnabled ?? true,
    voiceStack: config.voiceStack ?? 'inkbox_voice_ai',
    realtimeCredentialRef: config.realtimeCredentialRef?.trim() || 'INKBOX_REALTIME_API_KEY',
    realtimeModel: config.realtimeModel?.trim() || 'gpt-realtime-2',
    realtimeVoice: config.realtimeVoice?.trim() || 'cedar',
    channelInstructions: { ...config.channelInstructions },
  }
}
