import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type z from '@deepseek-ai/schemastery'
import { Config, type Config as PluginConfig, resolveConfig } from './config.js'
import { Gateway } from './gateway.js'
import { InkboxRuntime } from './runtime.js'
import { registerSkills } from './skills.js'
import { registerTools } from './tools.js'

export const name = 'inkbox'
export const inject = [
  'agents',
  'agentDefaultModel',
  'approval',
  'credentials',
  'sessions',
  'settings',
  'skills',
  'tools',
  'userQuestions',
]

export type { PluginConfig }
export { Config }

export async function apply(ctx: Context, config: PluginConfig): Promise<() => Promise<void>> {
  const scope = ctx.settings.register(settingsNamespace('inkbox'), Config as z<PluginConfig>, {
    base: config,
    applies: 'restart',
  })
  const resolved = resolveConfig(scope.get())
  const runtime = new InkboxRuntime(ctx, resolved)
  registerTools(ctx, runtime)
  registerSkills(ctx)
  if (!resolved.enabled) return async () => {}

  const gateway = new Gateway(ctx, runtime, resolved)
  try {
    await gateway.start()
  } catch (error) {
    await gateway.close().catch(() => {})
    throw error
  }

  const disposeQuestions = ctx.userQuestions.registerProvider({
    ask: (request) => gateway.askQuestions(request),
  })
  const disposeApproval = ctx.on('approval/request', (request, next) => {
    if (!gateway.ownsAgent(request.agent)) return next()
    return gateway.askApproval(request.agent, request.reason ?? `Run ${request.toolName}`, request.signal)
  })

  return async () => {
    disposeApproval()
    disposeQuestions()
    await gateway.close()
  }
}
