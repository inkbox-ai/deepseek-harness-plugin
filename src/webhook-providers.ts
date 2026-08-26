import { createHmac, timingSafeEqual } from 'node:crypto'
import { verifyWebhook } from '@inkbox/sdk'

type Json = Record<string, unknown>

export type WebhookAuthentication =
  | { outcome: 'verified'; source: 'inkbox' | 'github'; payload: Json }
  | { outcome: 'invalid'; detail: string }
  | { outcome: 'ignored'; detail: string }
  | { outcome: 'unavailable'; detail: string }

export interface WebhookSecrets {
  inkbox?: string
  github?: string
  externalEvents: boolean
}

function parseJson(body: Uint8Array): Json | undefined {
  try {
    const value = JSON.parse(Buffer.from(body).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
  } catch {
    return undefined
  }
}

function equalHex(expected: string, received: string): boolean {
  if (!/^[a-f0-9]+$/i.test(received) || expected.length !== received.length) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
}

export function authenticateWebhook(
  body: Uint8Array,
  headers: Headers,
  _requestUrl: string,
  secrets: WebhookSecrets,
): WebhookAuthentication {
  const githubSignature = headers.get('x-hub-signature-256')
  if (githubSignature !== null) {
    if (!secrets.externalEvents) return { outcome: 'ignored', detail: 'External events are disabled' }
    if (!secrets.github) return { outcome: 'unavailable', detail: 'GitHub webhook secret is not configured' }
    const received = githubSignature.startsWith('sha256=') ? githubSignature.slice(7) : ''
    const expected = createHmac('sha256', secrets.github).update(body).digest('hex')
    if (!equalHex(expected, received)) return { outcome: 'invalid', detail: 'Invalid GitHub signature' }
    const payload = parseJson(body)
    const deliveryId = headers.get('x-github-delivery')?.trim()
    const event = headers.get('x-github-event')?.trim()
    if (payload === undefined || !deliveryId || !event)
      return { outcome: 'invalid', detail: 'Invalid GitHub event envelope' }
    return {
      outcome: 'verified',
      source: 'github',
      payload: {
        id: `github:${deliveryId}`,
        event_type: `github.${event}`,
        data: { provider: 'github', delivery_id: deliveryId, event, payload },
      },
    }
  }

  if (!secrets.inkbox) return { outcome: 'unavailable', detail: 'Webhook signing key is unavailable' }
  const rawHeaders = Object.fromEntries(headers.entries())
  if (!verifyWebhook({ payload: Buffer.from(body), headers: rawHeaders, secret: secrets.inkbox }))
    return { outcome: 'invalid', detail: 'Invalid signature' }
  const payload = parseJson(body)
  if (payload === undefined) return { outcome: 'invalid', detail: 'Invalid JSON' }
  return { outcome: 'verified', source: 'inkbox', payload }
}
