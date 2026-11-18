import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { settleAgent } from '../src/agent-manager.js'

it('waits for owned running and stopping jobs and their subsequent native turns', async () => {
  const pending = [
    { id: 'own', ownerSession: 'session', status: 'running' },
    { id: 'foreign', ownerSession: 'other', status: 'running' },
    { id: 'unowned', status: 'running' },
  ]
  let release: (() => void) | undefined
  let secondTurn = false
  const agent = {
    session: { id: 'session' },
    whenIdle: vi.fn(async () => {
      if (secondTurn) pending.push({ id: 'followup', ownerSession: 'session', status: 'stopping' })
      secondTurn = false
    }),
  } as unknown as Agent
  const jobs = {
    list: vi.fn(() => pending),
    wait: vi.fn(async (id: string) => {
      if (id === 'own')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      const job = pending.find((item) => item.id === id)
      if (job) job.status = 'completed'
      if (id === 'own') secondTurn = true
    }),
  }
  let complete = false
  const work = settleAgent({ jobs } as unknown as Context, agent).then(() => {
    complete = true
  })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(complete).toBe(false)
  release?.()
  await work
  expect(jobs.wait.mock.calls.map((call) => call[0])).toEqual(['own', 'followup'])
  expect(complete).toBe(true)
})
