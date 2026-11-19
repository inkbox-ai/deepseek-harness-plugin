import { spawn } from 'node:child_process'
import type { RoutedEvent } from './routing.js'

export const INBOUND_SCRIPT_TIMEOUT_MS = 120_000
export const INBOUND_RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 600_000]
export const INBOUND_BODY_MAX_BYTES = 64 * 1024

export interface InboundEvent {
  eventId: string
  // Stable across retries of one delivery and new per replay, so a replay runs again.
  deliveryKey: string
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
  const sourceId = text(source.id)
  const sourceName = text(source.name)
  if (!eventId || !sourceId || !sourceName) return undefined
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
    deliveryKey: text(data.delivery_id) ?? eventId,
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
  return `(binary body, ${Buffer.from(event.body, 'base64').length} bytes, not shown)`
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
    const stdout: Buffer[] = []
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-500)
    })
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !timedOut) resolve({ ok: true, stdout: Buffer.concat(stdout).toString('utf8') })
      else
        resolve({
          ok: false,
          error: timedOut
            ? `Timed out after ${timeoutMs / 1000} s`
            : stderr.trim() || `Exited with ${signal ?? `code ${code}`}`,
        })
    })
    child.stdin.end(input)
  })
}
