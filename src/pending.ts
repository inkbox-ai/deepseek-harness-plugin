import { randomUUID } from 'node:crypto'
import type { RoutedEvent } from './routing.js'

/** The participant who may answer a prompt; only Slack-owned turns bind one. */
export interface ReplyAuthor {
  channel: RoutedEvent['channel']
  sender: string
}

export function sameAuthor(
  expected: ReplyAuthor | undefined,
  event: Pick<RoutedEvent, 'channel' | 'sender'>,
): boolean {
  return expected === undefined || (event.channel === expected.channel && event.sender === expected.sender)
}

interface Waiter {
  id: string
  author?: ReplyAuthor
  /** Set when the prompt is about to be sent; only an active waiter accepts answers. */
  activatedAt?: number
  timer?: ReturnType<typeof setTimeout>
  resolve?: (text: string) => void
  reject?: (error: Error) => void
  released: boolean
  /** Settles `cancelled` when the reservation is released. */
  settle(error: Error): void
  /** Removes the cancellation listeners installed at reservation. */
  detach(): void
}

/** One route's prompt, from the guard that reserves it to its answer or release. */
export interface PromptReservation {
  readonly id: string
  /** True once released by a failure, cancellation, stop or shutdown. */
  readonly released: boolean
  /** Resolves with the reason as soon as the reservation is released; it never rejects. */
  readonly cancelled: Promise<Error>
  /**
   * Start accepting answers. Called immediately before (Slack) or after (other
   * channels) the send. `signal`, when given, cancels from activation on.
   */
  activate(timeoutMs: number, signal?: AbortSignal): Promise<string>
  /** Remove this reservation only; an active waiter is rejected with `error`. */
  release(error?: Error): void
}

/**
 * Outstanding prompts, at most one per route. A route is reserved synchronously
 * at the guard, so a concurrent prompt is refused before anything is sent. A
 * reservation accepts answers only once activated, and a bound (Slack) answer
 * counts only if the prompt was already active when the answer arrived.
 */
export class PendingPrompts {
  private readonly waiters = new Map<string, Waiter>()
  private clock = 0
  private closed = false

  /** The arrival mark for an inbound message, taken before any await. */
  arrival(): number {
    return this.clock
  }

  get size(): number {
    return this.waiters.size
  }

  /**
   * Reserve the route. Each signal (the request, the owning turn) cancels the
   * reservation from this moment, reserved or active.
   */
  reserve(
    routeKey: string,
    author: ReplyAuthor | undefined,
    signals: readonly (AbortSignal | undefined)[] = [],
  ): PromptReservation | undefined {
    if (this.closed || this.waiters.has(routeKey)) return undefined
    let settle: (error: Error) => void = () => {}
    const cancelled = new Promise<Error>((resolve) => {
      settle = resolve
    })
    const listeners: (() => void)[] = []
    const waiter: Waiter = {
      id: randomUUID(),
      ...(author ? { author } : {}),
      released: false,
      settle,
      detach: () => {
        for (const remove of listeners.splice(0)) remove()
      },
    }
    this.waiters.set(routeKey, waiter)
    const release = (error?: Error) =>
      this.release(routeKey, waiter, error ?? new Error('Interaction cancelled'))
    for (const signal of signals) {
      if (signal === undefined) continue
      const abort = () =>
        release(signal.reason instanceof Error ? signal.reason : new Error('Interaction cancelled'))
      if (signal.aborted) {
        abort()
        break
      }
      signal.addEventListener('abort', abort, { once: true })
      listeners.push(() => signal.removeEventListener('abort', abort))
    }
    return {
      id: waiter.id,
      get released() {
        return waiter.released
      },
      cancelled,
      activate: (timeoutMs, signal) =>
        new Promise<string>((resolve, reject) => {
          if (waiter.released) {
            reject(new Error('Interaction cancelled'))
            return
          }
          waiter.resolve = resolve
          waiter.reject = reject
          waiter.activatedAt = ++this.clock
          waiter.timer = setTimeout(
            () => release(new Error('Timed out waiting for a channel reply')),
            timeoutMs,
          )
          if (signal !== undefined) {
            const abort = () =>
              release(signal.reason instanceof Error ? signal.reason : new Error('Interaction cancelled'))
            if (signal.aborted) abort()
            else {
              signal.addEventListener('abort', abort, { once: true })
              listeners.push(() => signal.removeEventListener('abort', abort))
            }
          }
        }),
      release,
    }
  }

  /**
   * Answer the route's active prompt with `text`. A bound prompt accepts only
   * its author, and only a message that arrived after the prompt was active.
   */
  tryConsume(
    routeKey: string,
    event: Pick<RoutedEvent, 'channel' | 'sender'>,
    text: string,
    arrival: number,
  ): boolean {
    const waiter = this.waiters.get(routeKey)
    if (waiter?.activatedAt === undefined || waiter.released || !text) return false
    if (waiter.author !== undefined && (!sameAuthor(waiter.author, event) || waiter.activatedAt > arrival))
      return false
    waiter.released = true
    waiter.detach()
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    this.waiters.delete(routeKey)
    waiter.resolve?.(text)
    return true
  }

  /** Release the route's prompt when it is bound to `author`, reserved or active. */
  cancelFor(routeKey: string, author: Pick<RoutedEvent, 'channel' | 'sender'>, error: Error): void {
    const waiter = this.waiters.get(routeKey)
    if (waiter?.author === undefined || !sameAuthor(waiter.author, author)) return
    this.release(routeKey, waiter, error)
  }

  close(): void {
    this.closed = true
    for (const [routeKey, waiter] of [...this.waiters])
      this.release(routeKey, waiter, new Error('Gateway stopped'))
  }

  private release(routeKey: string, waiter: Waiter, error: Error): void {
    if (waiter.released) return
    waiter.released = true
    waiter.detach()
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (this.waiters.get(routeKey) === waiter) this.waiters.delete(routeKey)
    waiter.settle(error)
    waiter.reject?.(error)
  }
}
