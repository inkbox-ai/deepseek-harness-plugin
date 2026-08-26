import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { AgentIdentity } from '@inkbox/sdk'
import type { SetupPrompts } from './onboarding.js'

const DEFAULT_BASE_URL = 'https://inkbox.ai'
const AVATAR_PATH = fileURLToPath(new URL('../../assets/deepseek_with_phone.png', import.meta.url))

export interface AvatarDependencies {
  read(path: string): Promise<Buffer>
  request(input: string, init: RequestInit): Promise<Response>
}

const defaults: AvatarDependencies = {
  read: (path) => readFile(path),
  request: (input, init) => fetch(input, init),
}

export async function configureAvatar(
  identity: AgentIdentity,
  apiKey: string,
  prompts: Pick<SetupPrompts, 'confirm'> | undefined,
  options: { baseUrl?: string; isSignup: boolean },
  dependencies: AvatarDependencies = defaults,
): Promise<void> {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  const url = `${baseUrl}/api/v1/identities/${encodeURIComponent(identity.agentHandle)}/avatar`
  if (!options.isSignup) {
    const existing = await dependencies
      .request(url, { method: 'GET', headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(10_000) })
      .catch(() => undefined)
    if (existing?.status === 200) return
    process.stdout.write('\nAgent avatar\n')
    process.stdout.write('This agent has no avatar on its Inkbox contact card.\n')
    if (!prompts || !(await prompts.confirm('Add the DeepSeek avatar?', true))) {
      process.stdout.write('Skipped. You can set an avatar later in the Inkbox console.\n')
      return
    }
  }

  try {
    const image = await dependencies.read(AVATAR_PATH)
    const form = new FormData()
    const bytes = new Uint8Array(image.byteLength)
    bytes.set(image)
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'deepseek_with_phone.png')
    const response = await dependencies.request(url, {
      method: 'PUT',
      headers: { 'X-API-Key': apiKey },
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
    process.stdout.write('Attached the DeepSeek avatar to this agent.\n')
  } catch (error) {
    process.stderr.write(
      `Could not attach the avatar: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.stderr.write('You can set one later in the Inkbox console.\n')
  }
}
