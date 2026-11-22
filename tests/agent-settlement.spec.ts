import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { AgentManager, settleAgent } from '../src/agent-manager.js'

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

function fakeAgent() {
  let submitted = false
  let release: () => void = () => {}
  const idle = new Promise<void>((resolve) => {
    release = resolve
  })
  const agent = {
    session: { id: 'session', seq: 0, events: [] },
    whenIdle: vi.fn(() => (submitted ? idle : Promise.resolve())),
    followup: vi.fn(() => {
      submitted = true
    }),
    cancel: vi.fn(() => release()),
  }
  const ctx = { sessions: { flush: vi.fn(async () => {}) } } as unknown as Context
  const manager = new AgentManager(ctx, {} as never, {} as never)
  vi.spyOn(manager, 'get').mockResolvedValue(agent as unknown as Agent)
  return { agent, manager }
}

it('cancels the running turn when the run is aborted', async () => {
  const { agent, manager } = fakeAgent()
  const controller = new AbortController()
  const run = manager.run('inbound:src', 'hi', { signal: controller.signal })
  await vi.waitFor(() => expect(agent.followup).toHaveBeenCalledOnce())
  controller.abort(new Error('timed out'))
  await expect(run).rejects.toThrow('timed out')
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'inkbox turn aborted' })
})

it('submits nothing when the run is aborted before it starts', async () => {
  const { agent, manager } = fakeAgent()
  await expect(
    manager.run('inbound:src', 'hi', { signal: AbortSignal.abort(new Error('stop')) }),
  ).rejects.toThrow('stop')
  expect(agent.followup).not.toHaveBeenCalled()
})
