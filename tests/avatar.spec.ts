import type { AgentIdentity } from '@inkbox/sdk'
import { describe, expect, it, vi } from 'vitest'
import { configureAvatar } from '../src/cli/avatar.js'

const identity = { agentHandle: 'deepseek-agent' } as AgentIdentity

describe('agent avatar onboarding', () => {
  it('automatically attaches the bundled avatar after self-signup', async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'PUT' ? new Response('', { status: 201 }) : new Response('', { status: 404 }),
    )
    const confirm = vi.fn(async () => true)
    await configureAvatar(
      identity,
      'ApiKey_agent',
      { confirm },
      { isSignup: true },
      {
        read: vi.fn(async () => Buffer.from('image')),
        request,
      },
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1].method).toBe('PUT')
  })

  it('never overwrites an existing avatar', async () => {
    const request = vi.fn(async () => new Response('', { status: 200 }))
    const read = vi.fn(async () => Buffer.from('image'))
    await configureAvatar(
      identity,
      'ApiKey_agent',
      { confirm: vi.fn(async () => true) },
      { isSignup: false },
      {
        read,
        request,
      },
    )
    expect(request).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  })
})
