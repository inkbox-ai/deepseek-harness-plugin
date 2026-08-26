import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import type { ReplyTarget } from './routing.js'

export interface RouteRecord {
  sessionId: string
  created: boolean
}

export interface PendingDelivery {
  eventIds: string[]
  target: ReplyTarget
  response: string
  attempts: number
  nextAttemptAt: number
}

export interface GatewayState {
  version: 1
  routingKey: string
  routes: Record<string, RouteRecord>
  seen: Record<string, number>
  replied: Record<string, number>
  deliveries: Record<string, PendingDelivery>
}

const EMPTY_AGE_MS = 14 * 24 * 60 * 60 * 1000

function freshState(): GatewayState {
  return {
    version: 1,
    routingKey: randomBytes(32).toString('base64url'),
    routes: {},
    seen: {},
    replied: {},
    deliveries: {},
  }
}

function validate(value: unknown): GatewayState {
  if (typeof value !== 'object' || value === null) throw new Error('Gateway state must be an object')
  const raw = value as Partial<GatewayState>
  if (raw.version !== 1 || typeof raw.routingKey !== 'string' || raw.routingKey.length < 32) {
    throw new Error('Gateway state has an unsupported format')
  }
  return {
    version: 1,
    routingKey: raw.routingKey,
    routes: raw.routes && typeof raw.routes === 'object' ? raw.routes : {},
    seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
    replied: raw.replied && typeof raw.replied === 'object' ? raw.replied : {},
    deliveries: validateDeliveries(raw.deliveries),
  }
}

function validateDeliveries(value: unknown): Record<string, PendingDelivery> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const validated: Record<string, PendingDelivery> = {}
  for (const [deliveryId, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
    const raw = candidate as Partial<PendingDelivery>
    if (
      !Array.isArray(raw.eventIds) ||
      !raw.eventIds.every((eventId) => typeof eventId === 'string') ||
      typeof raw.target !== 'object' ||
      raw.target === null ||
      typeof raw.response !== 'string' ||
      typeof raw.attempts !== 'number' ||
      typeof raw.nextAttemptAt !== 'number'
    )
      continue
    validated[deliveryId] = raw as PendingDelivery
  }
  return validated
}

export class StateStore {
  private state: GatewayState | undefined
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    try {
      await stat(this.path)
    } catch {
      const handle = await open(this.path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return undefined
        throw error
      })
      if (handle !== undefined) {
        try {
          await handle.writeFile(`${JSON.stringify(freshState())}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    }
    this.state = await this.read()
  }

  snapshot(): GatewayState {
    if (this.state === undefined) throw new Error('Gateway state has not been initialized')
    return structuredClone(this.state)
  }

  async mutate<T>(change: (state: GatewayState) => T): Promise<T> {
    const operation = this.mutationTail.then(() => this.mutateLocked(change))
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async mutateLocked<T>(change: (state: GatewayState) => T): Promise<T> {
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 8, minTimeout: 20, maxTimeout: 250 },
    })
    try {
      const current = await this.read()
      const result = change(current)
      prune(current, Date.now())
      await this.write(current)
      this.state = current
      return result
    } finally {
      await release()
    }
  }

  private async read(): Promise<GatewayState> {
    return validate(JSON.parse(await readFile(this.path, 'utf8')))
  }

  private async write(state: GatewayState): Promise<void> {
    const temp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temp, this.path)
  }
}

function prune(state: GatewayState, now: number): void {
  const cutoff = now - EMPTY_AGE_MS
  for (const table of [state.seen, state.replied]) {
    for (const [key, timestamp] of Object.entries(table)) if (timestamp < cutoff) delete table[key]
  }
}
