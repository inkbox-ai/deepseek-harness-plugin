import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authenticateWebhook } from '../src/webhook-providers.js'

const secret = 'github-test-secret'
const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'org/repo' } }))

function githubHeaders(signature?: string): Headers {
  return new Headers({
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'push',
    'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  })
}

describe('webhook provider authentication', () => {
  it('normalizes a verified GitHub delivery into an external event', () => {
    expect(
      authenticateWebhook(body, githubHeaders(), 'https://agent.example.test/webhook', {
        externalEvents: true,
        github: secret,
      }),
    ).toMatchObject({
      outcome: 'verified',
      source: 'github',
      payload: {
        id: 'github:delivery-1',
        event_type: 'github.push',
        data: { provider: 'github', delivery_id: 'delivery-1', event: 'push' },
      },
    })
  })

  it('rejects a present but invalid provider signature', () => {
    expect(
      authenticateWebhook(body, githubHeaders('sha256=deadbeef'), 'https://agent.example.test/webhook', {
        externalEvents: true,
        github: secret,
      }),
    ).toMatchObject({ outcome: 'invalid' })
  })

  it('fails closed when the matching provider has no configured secret', () => {
    expect(
      authenticateWebhook(body, githubHeaders(), 'https://agent.example.test/webhook', {
        externalEvents: true,
      }),
    ).toMatchObject({ outcome: 'unavailable' })
  })

  it('ignores external providers while the feature is disabled', () => {
    expect(
      authenticateWebhook(body, githubHeaders(), 'https://agent.example.test/webhook', {
        externalEvents: false,
        github: secret,
      }),
    ).toMatchObject({ outcome: 'ignored' })
  })

  it('rejects malformed provider envelopes after signature verification', () => {
    const headers = githubHeaders()
    headers.delete('x-github-delivery')
    expect(
      authenticateWebhook(body, headers, 'https://agent.example.test/webhook', {
        externalEvents: true,
        github: secret,
      }),
    ).toMatchObject({ outcome: 'invalid' })
  })
})
