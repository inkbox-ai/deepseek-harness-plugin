import { createHash } from 'node:crypto'
import { type Inkbox, InkboxAPIError, InkboxConnectionError, type SlackConnection } from '@inkbox/sdk'
import { TRANSCRIPTION_FINISHED, transcriptionEventUnsupported, type VoiceEvent } from './voice-notes.js'

/** Incoming Slack message kinds delivered to the agent. */
export const SLACK_EVENTS = [
  'slack.dm_received',
  'slack.group_dm_received',
  'slack.channel_message_received',
  'slack.mention_received',
  'slack.thread_reply_received',
] as const
export const SLACK_STOP = 'slack.session_stopped'
export const SLACK_SUBSCRIPTION_EVENTS: readonly string[] = [...SLACK_EVENTS, SLACK_STOP]

export interface SlackRoute {
  connectionGeneration?: number
  identityId: string
  connectionId: string
  workspaceId: string
  conversationId: string
  actorId: string
  messageTs: string
  threadTs: string | null
  sourceEventId: string
  author: string
  mentioned: boolean
  addressed: boolean
  direct: boolean
  rawText: string
  text: string
  senderAccess?: string
  contactId?: string
  nativeStop?: boolean
}

/** The persisted part of a route that a reply needs. */
export type SlackReplyRoute = Pick<
  SlackRoute,
  'identityId' | 'connectionId' | 'workspaceId' | 'conversationId' | 'threadTs' | 'sourceEventId'
> & { connectionGeneration?: number }

const record = (value: unknown): value is VoiceEvent =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0')

export function isSlackEvent(eventType: unknown): boolean {
  return typeof eventType === 'string' && eventType.startsWith('slack.')
}

export function parseSlack(event: VoiceEvent, identityId: string): SlackRoute | undefined {
  const d = event.data
  if (!record(d) || d.identity_id !== identityId || !nonempty(event.id)) return
  if (![...SLACK_EVENTS, SLACK_STOP].includes(event.event_type)) return
  const stop = event.event_type === SLACK_STOP
  if (!record(d.event) || (stop && d.event.type !== 'agent_session_stopped')) return
  // Sponsored senders reach the agent only through a mode this plugin does not run.
  if (!stop && 'sender_access' in d && d.sender_access !== 'direct') return
  if (!['connection_id', 'workspace_id', 'conversation_id', 'actor_id'].every((k) => nonempty(d[k]))) return
  if (d.event.bot_id || d.event.app_id || d.event.subtype === 'bot_message') return
  if (d.thread_ts != null && !nonempty(d.thread_ts)) return
  if (stop && !d.thread_ts) return
  const messageTs = stop ? d.thread_ts : d.message_ts
  if (!nonempty(messageTs)) return
  const kinds = stop ? ['thread'] : (d.message_kinds ?? [])
  if (!Array.isArray(kinds)) return
  const direct = kinds.includes('dm'),
    mentioned = kinds.includes('mention')
  const rawText = stop ? '/stop' : (d.event.text ?? '')
  if (typeof rawText !== 'string') return
  const files = Array.isArray(d.event.files)
    ? d.event.files
        .filter(record)
        .map((file: Record<string, unknown>) =>
          Object.fromEntries(
            ['id', 'name', 'mimetype', 'size'].filter((k) => k in file).map((k) => [k, file[k]]),
          ),
        )
    : []
  const text =
    rawText + (files.length ? `\nAttachment references (not downloaded): ${JSON.stringify(files)}` : '')
  if (!text.trim()) return
  return {
    identityId,
    connectionId: d.connection_id,
    workspaceId: d.workspace_id,
    conversationId: d.conversation_id,
    actorId: d.actor_id,
    messageTs,
    // A plain DM stays top-level; everything else continues in its Slack thread.
    threadTs: d.thread_ts || (direct && !mentioned ? null : messageTs),
    sourceEventId: event.id,
    author: `${d.workspace_id}:${d.actor_id}`,
    mentioned,
    direct,
    addressed: direct || mentioned || kinds.includes('group_dm'),
    rawText,
    text,
    ...(typeof d.sender_access === 'string' ? { senderAccess: d.sender_access } : {}),
    ...(typeof d.contact_id === 'string' && d.contact_id ? { contactId: d.contact_id } : {}),
    ...(stop ? { nativeStop: true } : {}),
  }
}

export function slackRouteKey(
  route: Pick<SlackRoute, 'identityId' | 'connectionId' | 'conversationId' | 'threadTs'>,
): string {
  return JSON.stringify([route.identityId, route.connectionId, route.conversationId, route.threadTs])
}

/** The message text without a leading mention of this app. */
export function slackControlText(route: SlackRoute, botUserId?: string): string {
  return botUserId
    ? route.rawText.replace(new RegExp(`^\\s*<@${botUserId}>[,:]?\\s*`), '').trim()
    : route.rawText.trim()
}

/** The connection list was read and does not grant this identity the connection. */
export class SlackConnectionDenied extends Error {}

export async function ownSlackConnection(
  client: Inkbox,
  identityId: string,
  connectionId: string,
  workspaceId?: string,
  generation?: number,
): Promise<SlackConnection> {
  const matches = (await client.slack.listConnections(identityId)).connections.filter(
    (connection) => connection.id === connectionId,
  )
  const match = matches[0]
  if (
    matches.length !== 1 ||
    match === undefined ||
    match.identityId !== identityId ||
    match.status !== 'connected' ||
    (workspaceId !== undefined && match.workspaceId !== workspaceId) ||
    (generation !== undefined && match.generation !== generation)
  )
    throw new SlackConnectionDenied('Slack connection is not connected to this identity.')
  return match
}

/**
 * A read that may succeed when repeated: a timeout, a connection failure, 408,
 * 429 or 5xx. Every other error is final.
 */
export function retryableRead(error: unknown): boolean {
  if (error instanceof InkboxConnectionError) return true
  const err = error as {
    status?: number
    statusCode?: number
    name?: string
    code?: string
    cause?: { code?: string }
  } | null
  const status = err?.statusCode ?? err?.status
  return (
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status < 600) ||
    ['TimeoutError', 'AbortError', 'NetworkError', 'InkboxConnectionError'].includes(err?.name ?? '') ||
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(err?.code ?? err?.cause?.code ?? '')
  )
}

/**
 * Register the incoming Slack message kinds for this identity at `url`.
 * Slack voice-note completions reach only a subscription that also selects the
 * original Slack message, so one Slack message subscription carries
 * `message.transcription_finished`.
 */
export async function reconcileSlackSubscription(
  client: Inkbox,
  identityId: string,
  url: string,
): Promise<void> {
  const subscriptions = client.webhooks.subscriptions
  const all = (await subscriptions.list({ agentIdentityId: identityId, scope: 'identity', url })).filter(
    (subscription) => subscription.url === url,
  )
  const rows = all.filter((subscription) =>
    subscription.eventTypes.some((event) => SLACK_SUBSCRIPTION_EVENTS.includes(event)),
  )
  if (rows.some((subscription) => subscription.status !== 'active'))
    throw new Error('The Slack subscription is paused; resume it before starting.')
  const covered = new Set(rows.flatMap((subscription) => subscription.eventTypes))
  const missing = SLACK_SUBSCRIPTION_EVENTS.filter((event) => !covered.has(event))
  const incoming = (subscription: { eventTypes: string[] }) =>
    subscription.eventTypes.filter((event) => (SLACK_EVENTS as readonly string[]).includes(event)).length
  const messages = rows.filter((subscription) => incoming(subscription) > 0)
  const target =
    messages.find((subscription) => subscription.eventTypes.includes(TRANSCRIPTION_FINISHED)) ??
    [...messages].sort((a, b) => incoming(b) - incoming(a))[0]
  const finished = !target?.eventTypes.includes(TRANSCRIPTION_FINISHED)
  if (!missing.length && !finished) return
  // Each event is held by one active subscription per URL, so move it here.
  if (finished)
    await releaseFinished(
      client,
      all.filter((subscription) => subscription !== target),
    )
  const apply = (wanted: string[]) =>
    target
      ? subscriptions.update(target.id, {
          scope: 'identity',
          eventTypes: [...new Set([...target.eventTypes, ...wanted])],
        })
      : subscriptions.create({ agentIdentityId: identityId, url, eventTypes: wanted })
  try {
    await apply([...missing, ...(finished ? [TRANSCRIPTION_FINISHED] : [])])
  } catch (error) {
    if (!finished || !transcriptionEventUnsupported(error)) throw error
    // Keep Slack messages flowing on a server without transcription callbacks.
    if (missing.length) await apply(missing)
  }
}

async function releaseFinished(
  client: Inkbox,
  rows: { id: string; status: string; eventTypes: string[] }[],
): Promise<void> {
  for (const row of rows) {
    if (row.status !== 'active' || !row.eventTypes.includes(TRANSCRIPTION_FINISHED)) continue
    const remaining = row.eventTypes.filter((event) => event !== TRANSCRIPTION_FINISHED)
    if (remaining.length)
      await client.webhooks.subscriptions.update(row.id, { scope: 'identity', eventTypes: remaining })
    else
      await client.webhooks.subscriptions.delete(row.id).catch((error: unknown) => {
        if (!(error instanceof InkboxAPIError) || error.statusCode !== 404) throw error
      })
  }
}

/** Conservative repair outside code; complex Markdown is left intact rather than guessed. */
export function slackMrkdwn(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(
              /\[([^[\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/g,
              (_match, label: string, url: string) =>
                `<${url.replaceAll('&', '&amp;')}|${label.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}>`,
            )
            .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
            .replace(/^#{1,6} (.+)$/gm, '*$1*'),
    )
    .join('')
}

export function slackText(text: string): void {
  if (!text || [...text].length > 12_000 || text.includes('\0'))
    throw new Error('Slack text must be 1–12000 characters without NUL characters.')
}

/** Send one reply to the source conversation and thread; an unconfirmed send is never repeated blindly. */
export async function sendSlackReply(client: Inkbox, route: SlackReplyRoute, text: string): Promise<string> {
  return (await prepareSlackReply(client, route, text))()
}

/**
 * Validate the text and the connection before anything is sent. The returned
 * function performs the send itself, so a failed check never reaches Slack.
 */
export async function prepareSlackReply(
  client: Inkbox,
  route: SlackReplyRoute,
  text: string,
  /** Distinguishes in-memory sends such as prompts; a durable reply omits it to keep a stable key. */
  nonce?: string,
): Promise<() => Promise<string>> {
  text = slackMrkdwn(text)
  slackText(text)
  await ownSlackConnection(
    client,
    route.identityId,
    route.connectionId,
    route.workspaceId,
    route.connectionGeneration,
  )
  return async () => {
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          route.sourceEventId,
          slackRouteKey(route),
          text,
          ...(nonce === undefined ? [] : [nonce]),
        ]),
      )
      .digest('hex')
    const action = await client.slack.sendMessage(route.connectionId, {
      conversationId: route.conversationId,
      threadTs: route.threadTs,
      text,
      idempotencyKey: `deepseek:${key}`,
    })
    if (action.status !== 'sent')
      throw new Error(
        `Slack action ${action.id} is ${action.status}; inspect it with inkbox_slack_get_action before deciding whether to send again.`,
      )
    return action.id
  }
}
