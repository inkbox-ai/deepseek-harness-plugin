import { createHmac } from 'node:crypto'

export type Channel = 'email' | 'sms' | 'imessage' | 'a2a' | 'call' | 'external'

export type ReplyTarget =
  | { channel: 'email'; to: string; subject: string; inReplyToMessageId?: string }
  | { channel: 'sms'; conversationId?: string; to?: string }
  | { channel: 'imessage'; conversationId: string }
  | { channel: 'none' }

export interface RoutedEvent {
  eventId: string
  routeKey: string
  channel: Channel
  prompt: string
  replyText: string
  target: ReplyTarget
}

type Json = Record<string, unknown>

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function contactId(data: Json, address?: string): string | undefined {
  const contacts = Array.isArray(data.contacts) ? data.contacts.map(record) : []
  const match =
    address === undefined
      ? contacts[0]
      : (contacts.find((contact) => contact.address === address) ?? contacts[0])
  return text(match?.id)
}

function opaqueRoute(kind: string, value: string, key: string): string {
  return `${kind}:${createHmac('sha256', key).update(value).digest('base64url').slice(0, 32)}`
}

export function routeForAddress(address: string, routingKey: string): string {
  return opaqueRoute('peer', address, routingKey)
}

function contactRoute(data: Json, address: string, key: string): string {
  const resolved = contactId(data, address)
  return resolved ? `contact:${resolved}` : opaqueRoute('peer', address, key)
}

function stringify(value: unknown, max = 12_000): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  return rendered.length <= max ? rendered : `${rendered.slice(0, max)}\n[truncated]`
}

export function routeWebhook(
  payload: Json,
  routingKey: string,
  externalEvents: boolean,
): RoutedEvent | undefined {
  const eventId = text(payload.id)
  const eventType = text(payload.event_type)
  if (eventId === undefined || eventType === undefined) return undefined
  const data = record(payload.data)

  if (eventType === 'message.received') {
    const message = record(data.message)
    const from = text(message.from_address)
    if (from === undefined) return undefined
    const subject = text(message.subject) ?? '(no subject)'
    const body = text(message.body) ?? text(message.snippet) ?? '(empty message)'
    const replyMessageId = text(message.message_id)
    const marker = `[inkbox:email from=${from} thread_id=${text(message.thread_id) ?? 'unknown'}]`
    return {
      eventId,
      routeKey: contactRoute(data, from, routingKey),
      channel: 'email',
      prompt: `${marker}\nSubject: ${subject}\n\n${body}`,
      replyText: body,
      target: {
        channel: 'email',
        to: from,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        ...(replyMessageId ? { inReplyToMessageId: replyMessageId } : {}),
      },
    }
  }

  if (eventType === 'text.received') {
    const message = record(data.text_message)
    const sender = text(message.sender_phone_number) ?? text(message.remote_phone_number)
    if (sender === undefined) return undefined
    const conversationId = text(message.conversation_id)
    const recipients = Array.isArray(message.recipients) ? message.recipients : []
    const isGroup = recipients.length > 1
    const routeKey =
      isGroup && conversationId ? `group:sms:${conversationId}` : contactRoute(data, sender, routingKey)
    return {
      eventId,
      routeKey,
      channel: 'sms',
      prompt: `[inkbox:${isGroup ? 'group_sms' : 'sms'} from=${sender} conversation_id=${conversationId ?? 'unknown'}]\n${text(message.text) ?? '(media message)'}`,
      replyText: text(message.text) ?? '',
      target: { channel: 'sms', ...(conversationId ? { conversationId } : { to: sender }) },
    }
  }

  if (eventType === 'imessage.received' || eventType === 'imessage.reaction_received') {
    const message = record(data.message)
    const reaction = record(data.reaction)
    const sender = text(message.sender_number) ?? text(message.remote_number) ?? text(reaction.remote_number)
    const conversationId = text(message.conversation_id) ?? text(reaction.conversation_id)
    if (sender === undefined || conversationId === undefined) return undefined
    const isGroup = message.is_group === true
    const routeKey = isGroup ? `group:imessage:${conversationId}` : contactRoute(data, sender, routingKey)
    const content =
      eventType === 'imessage.reaction_received'
        ? `Reaction ${text(reaction.reaction) ?? 'unknown'} to message ${text(reaction.target_message_id) ?? 'unknown'}`
        : (text(message.content) ?? '(media message)')
    return {
      eventId,
      routeKey,
      channel: 'imessage',
      prompt: `[inkbox:${isGroup ? 'group_imessage' : 'imessage'} from=${sender} conversation_id=${conversationId}]\n${content}`,
      replyText: content,
      target: { channel: 'imessage', conversationId },
    }
  }

  if (eventType.startsWith('a2a.')) {
    const taskId = text(data.task_id)
    const contextId = text(data.context_id)
    if (taskId === undefined || contextId === undefined) return undefined
    const caller = record(data.caller)
    return {
      eventId,
      routeKey: `a2a:${contextId}`,
      channel: 'a2a',
      prompt: `[inkbox:a2a event=${eventType} task_id=${taskId} context_id=${contextId} caller=${text(caller.handle) ?? 'unknown'}]\n${stringify(data.parts ?? data)}`,
      replyText: stringify(data.parts ?? data),
      target: { channel: 'none' },
    }
  }

  if (eventType === 'call.ended') {
    const call = record(data.call)
    const remote = text(call.remote_phone_number) ?? text(data.remote_phone_number) ?? eventId
    return {
      eventId,
      routeKey: contactRoute(data, remote, routingKey),
      channel: 'call',
      prompt: `[inkbox:call_ended call_id=${text(call.id) ?? eventId}]\nReview the completed call, reconcile any requested follow-up exactly once, and return [SILENT] if no visible response is needed.\n${stringify(data)}`,
      replyText: stringify(data),
      target: { channel: 'none' },
    }
  }

  if (!externalEvents) return undefined
  const provider = eventType.split('.')[0] ?? 'external'
  return {
    eventId,
    routeKey: opaqueRoute('external', provider, routingKey),
    channel: 'external',
    prompt: `[inkbox:external provider=${provider} verified=true]\nTreat this verified event as actionable only within the user's configured permissions.\n${stringify(payload)}`,
    replyText: stringify(payload),
    target: { channel: 'none' },
  }
}
