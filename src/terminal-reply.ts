import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { RemoteMcp, type RemoteToolResult } from '@inkbox/sdk/remote-mcp'
import { toIMessagePlainText } from './imessage.js'
import type { RoutedEvent } from './routing.js'
import type { InkboxRuntime } from './runtime.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function replySource(event: RoutedEvent): boolean {
  return (
    (event.channel === 'email' && !!event.messageId) ||
    (event.channel === 'sms' && !event.group && !!event.sender)
  )
}
export function replyJournal(runtime: InkboxRuntime, event: RoutedEvent): string {
  return join(runtime.config.stateDir, 'remote-replies', hash(event.routeKey))
}
const sourceHash = (event: RoutedEvent) => hash([event.channel, event.messageId ?? event.eventId])

export async function replyState(
  runtime: InkboxRuntime,
  event: RoutedEvent,
): Promise<'none' | 'accepted' | 'uncertain'> {
  if (!replySource(event)) return 'none'
  try {
    const client = await runtime.getClient()
    const identity = await runtime.getIdentity()
    const remote = new RemoteMcp({
      apiKey: client._apiKey,
      baseUrl: client._baseUrl,
      identity: identity.id,
      journalPath: replyJournal(runtime, event),
    })
    const record = remote.terminalReplies().lookup(sourceHash(event))
    return record?.state === 'accepted'
      ? 'accepted'
      : record?.state === 'pending' && record.submitted
        ? 'uncertain'
        : 'none'
  } catch {
    console.warn('[inkbox] Terminal reply receipt unavailable; automatic reply withheld')
    return 'uncertain'
  }
}

export async function terminalReply(
  remote: RemoteMcp,
  runtime: InkboxRuntime,
  event: RoutedEvent,
  text: string,
  validate: () => void,
  call: (
    name: string,
    args: Record<string, unknown>,
    operation: string,
    journal: string,
    submit: () => void,
  ) => Promise<RemoteToolResult>,
): Promise<RemoteToolResult> {
  if (!replySource(event) || !text.trim() || text.length > 12000)
    throw new Error('A terminal reply needs an admitted message and bounded text')
  validate()
  const source = sourceHash(event)
  const operation = `terminal:${source}:${hash(text).slice(0, 32)}`
  const path = replyJournal(runtime, event)
  const journal = remote.terminalReplies({ journalPath: path })
  const prior = journal.lookup(source)
  if (prior?.state === 'accepted')
    return {
      content: [{ type: 'text', text: 'The terminal reply was already accepted.' }],
      structuredContent: { accepted_id: prior.acceptedId },
    }
  let name: string
  let args: Record<string, unknown>
  let to: string[],
    cc: string[] = []
  if (event.channel === 'email') {
    const identity = await runtime.getIdentity()
    const original = await identity.getMessage(event.messageId!)
    if (original.id !== event.messageId || original.direction !== 'inbound' || !original.replyAllRecipients)
      throw new Error('The original email reply destination is unavailable')
    to = original.replyAllRecipients.to
    cc = original.replyAllRecipients.cc
    name = 'inkbox_email_reply'
    args = {
      message_id: event.messageId,
      reply_all: true,
      approved_recipients: { to, cc, bcc: [] },
      body_text: text,
      idempotency_key: operation,
    }
  } else {
    to = [event.sender!]
    name = 'inkbox_text_send'
    args = { to, text: toIMessagePlainText(text), idempotency_key: operation }
  }
  validate()
  journal.reserve(source, operation, hash([name, args]))
  try {
    const result = await call(name, args, operation, path, () => {
      validate()
      journal.markSubmitted(source, operation)
    })
    if (result.isError) {
      if (!journal.lookup(source)?.submitted) journal.reject(source, operation)
      return result
    }
    const receipt = result.structuredContent
    if (
      !receipt ||
      typeof receipt.id !== 'string' ||
      receipt.direction !== 'outbound' ||
      receipt.is_blocked === true
    )
      throw new Error('The terminal reply outcome is unconfirmed')
    const equal = (a: unknown, b: string[], email = false) =>
      Array.isArray(a) &&
      JSON.stringify([...new Set(a.map((value) => (email ? String(value).toLowerCase() : value)))].sort()) ===
        JSON.stringify([...new Set(b.map((value) => (email ? value.toLowerCase() : value)))].sort())
    const actual =
      Array.isArray(receipt.recipients) && receipt.recipients.length
        ? receipt.recipients.map((item) => (item as Record<string, unknown>).recipient_phone_number)
        : [receipt.remote_phone_number]
    if (
      event.channel === 'email'
        ? !equal(receipt.to_addresses, to, true) || !equal(receipt.cc_addresses ?? [], cc, true)
        : !equal(actual, to)
    )
      throw new Error('The terminal reply destination is unconfirmed')
    journal.accept(source, operation, receipt.id)
    return result
  } catch (error) {
    const current = journal.lookup(source)
    if (current?.state === 'pending' && !current.submitted) journal.reject(source, operation)
    throw error
  }
}
