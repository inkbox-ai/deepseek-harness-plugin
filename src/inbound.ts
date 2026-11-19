import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoutedEvent } from './routing.js'

export const INBOUND_SCRIPT_TIMEOUT_MS = 120_000
export const INBOUND_TURN_TIMEOUT_MS = 30 * 60_000
export const INBOUND_RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 600_000]
export const INBOUND_BODY_MAX_BYTES = 64 * 1024
export const INBOUND_STDERR_TAIL_BYTES = 4 * 1024
export const INBOUND_REPORT_ERROR_MAX_CHARS = 2000

export interface InboundEvent {
  eventId: string
  // Stable across retries of one delivery and new per replay, so a replay runs again.
  deliveryId: string
  sourceId: string
  sourceName: string
  instructions?: string
  handler: { type: 'agent' } | { type: 'script'; command: string }
  headers: Record<string, string>
  body: string
  bodyEncoding: 'utf8' | 'base64'
}

export type ScriptResult = { ok: true; stdout: string } | { ok: false; error: string }

type Json = Record<string, unknown>

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function parseInbound(payload: Json): InboundEvent | undefined {
  const data = record(payload.data)
  const source = record(data.source)
  const handler = record(data.handler)
  const request = record(data.request)
  const eventId = text(data.event_id)
  const deliveryId = text(data.delivery_id)
  const sourceId = text(source.id)
  const sourceName = text(source.name)
  if (!eventId || !deliveryId || !sourceId || !sourceName) return undefined
  const command = text(handler.command)
  const parsedHandler =
    handler.type === 'agent'
      ? ({ type: 'agent' } as const)
      : handler.type === 'script' && command
        ? ({ type: 'script', command } as const)
        : undefined
  if (!parsedHandler) return undefined
  const headers = Object.fromEntries(
    Object.entries(record(request.headers)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  const instructions = text(source.instructions)
  return {
    eventId,
    deliveryId,
    sourceId,
    sourceName,
    ...(instructions ? { instructions } : {}),
    handler: parsedHandler,
    headers,
    body: typeof request.body === 'string' ? request.body : '',
    bodyEncoding: request.body_encoding === 'base64' ? 'base64' : 'utf8',
  }
}

export function truncateInboundBody(body: string): string {
  const bytes = Buffer.from(body, 'utf8')
  if (bytes.length <= INBOUND_BODY_MAX_BYTES) return body
  let end = INBOUND_BODY_MAX_BYTES
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return `${bytes.subarray(0, end).toString('utf8')}\n(truncated)`
}

export function inboundBody(event: InboundEvent): string {
  if (event.bodyEncoding === 'utf8') return truncateInboundBody(event.body) || '(empty body)'
  const bytes = Buffer.from(event.body, 'base64')
  try {
    // Text can arrive base64-encoded too; only bytes that are not UTF-8 are withheld.
    return truncateInboundBody(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) || '(empty body)'
  } catch {
    return `(binary body, ${bytes.length} bytes, not shown)`
  }
}

export function inboundRoutedEvent(trackingId: string, event: InboundEvent, body: string): RoutedEvent {
  const context = [
    `[inkbox:inbound source=${event.sourceName} event_id=${event.eventId}]`,
    `Untrusted external content received from inbound source "${event.sourceName}". There is no channel to reply on.`,
    ...(event.instructions ? ['', 'Source instructions:', event.instructions] : []),
  ].join('\n')
  return {
    eventId: trackingId,
    routeKey: `inbound:${event.sourceName}`,
    channel: 'external',
    context,
    content: body,
    replyText: body,
    target: { channel: 'none' },
  }
}

export function scriptInput(event: InboundEvent): string {
  return JSON.stringify({
    source: event.sourceName,
    event_id: event.eventId,
    headers: event.headers,
    body: event.body,
    body_encoding: event.bodyEncoding,
  })
}

export function runInboundScript(
  command: string,
  cwd: string,
  input: string,
  timeoutMs = INBOUND_SCRIPT_TIMEOUT_MS,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    // A separate process group lets a timeout kill everything the shell started.
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: 'pipe' })
    // One byte past the cap is enough for truncateInboundBody to mark the cut.
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length <= INBOUND_BODY_MAX_BYTES)
        stdout = Buffer.concat([stdout, chunk]).subarray(0, INBOUND_BODY_MAX_BYTES + 1)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-INBOUND_STDERR_TAIL_BYTES)
    })
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) {
        resolve({ ok: true, stdout: truncateInboundBody(stdout.toString('utf8')) })
      } else
        resolve({
          ok: false,
          error: timedOut
            ? `Timed out after ${timeoutMs / 1000} s`
            : stderr.toString('utf8').trim() || `Exited with ${signal ?? `code ${code}`}`,
        })
    })
    child.stdin.end(input)
  })
}

export interface PendingInbound {
  // Envelope id the host tracks this delivery by.
  trackingId: string
  event: InboundEvent
  // Script stdout once the script succeeded; the agent turn then uses it as the body.
  output?: string
  // Set before the agent turn starts; an interrupted turn is reported, never repeated.
  turnStarted?: boolean
  attempts: number
  dueAt: number
  report?: { error: string; attempts: number; dueAt: number }
}

// One file per delivery keeps large bodies out of the shared gateway state.
export class InboundStore {
  constructor(readonly dir: string) {}

  async load(): Promise<PendingInbound[]> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const items: PendingInbound[] = []
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const item = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as PendingInbound
        if (typeof item?.event?.deliveryId === 'string' && typeof item.attempts === 'number') items.push(item)
      } catch {}
    }
    return items
  }

  async save(item: PendingInbound): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const path = this.path(item.event.deliveryId)
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(item), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
    const dir = await open(this.dir, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }

  async remove(deliveryId: string): Promise<void> {
    await rm(this.path(deliveryId), { force: true })
  }

  private path(deliveryId: string): string {
    return join(this.dir, `${createHash('sha256').update(deliveryId).digest('hex')}.json`)
  }
}
