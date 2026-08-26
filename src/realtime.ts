import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { type Inkbox, verifyWebhook } from '@inkbox/sdk'
import type { InkboxWebSocket } from '@inkbox/sdk/tunnels/connect'
import { WebSocket } from 'undici'

type Json = Record<string, unknown>

export interface RealtimeCallMeta {
  callId: string
  contactId?: string
  direction: 'inbound' | 'outbound'
  remotePhoneNumber?: string
  contactName?: string
  agentHandle: string
  agentEmail?: string
  agentPhone?: string
  purpose?: string
  openingMessage?: string
}

export interface RealtimeConfiguration {
  apiKey: string
  model: string
  voice: string
  additionalInstructions?: string
  baseUrl?: string
}

export interface RealtimeCallbacks {
  consult(query: string, transcript: readonly TranscriptTurn[]): Promise<string>
  ended(transcript: readonly TranscriptTurn[], actions: readonly PostCallAction[]): Promise<void>
}

export interface TranscriptTurn {
  party: 'agent' | 'caller'
  text: string
}

export interface PostCallAction {
  action: string
  details: string
}

export interface RealtimeConnection extends AsyncIterable<Json> {
  send(event: Json): Promise<void>
  close(code?: number, reason?: string): Promise<void>
}

export type RealtimeConnector = (
  configuration: RealtimeConfiguration,
  meta: RealtimeCallMeta,
) => Promise<RealtimeConnection>

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime'
const CONNECT_TIMEOUT_MS = 12_000
const VALIDATION_TIMEOUT_MS = 8_000

function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

class OpenAIConnection implements RealtimeConnection {
  private readonly queue: Json[] = []
  private waiter: ((value: IteratorResult<Json>) => void) | undefined
  private ended = false

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      try {
        const value = JSON.parse(String(event.data)) as unknown
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) this.push(value as Json)
      } catch {}
    })
    socket.addEventListener('close', () => this.finish())
    socket.addEventListener('error', () => this.finish())
  }

  async send(event: Json): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('OpenAI Realtime connection is closed')
    this.socket.send(JSON.stringify(event))
  }

  async close(code = 1000, reason = 'complete'): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
      this.socket.close(code, reason)
    this.finish()
  }

  [Symbol.asyncIterator](): AsyncIterator<Json> {
    return {
      next: () => {
        const value = this.queue.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
    }
  }

  private push(value: Json): void {
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ done: false, value })
    } else this.queue.push(value)
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    this.waiter?.({ done: true, value: undefined })
    this.waiter = undefined
  }
}

function sessionUpdate(configuration: RealtimeConfiguration, meta: RealtimeCallMeta): Json {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: configuration.model,
      instructions: buildRealtimeInstructions(meta, configuration.additionalInstructions),
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          noise_reduction: null,
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { format: { type: 'audio/pcmu' }, voice: configuration.voice },
      },
      tools: realtimeTools(),
      tool_choice: 'auto',
    },
  }
}

export const connectOpenAIRealtime: RealtimeConnector = async (configuration, meta) => {
  const url = new URL(configuration.baseUrl ?? OPENAI_REALTIME_URL)
  url.searchParams.set('model', configuration.model)
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${configuration.apiKey}` } })
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out connecting to OpenAI Realtime'))
    }, CONNECT_TIMEOUT_MS)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout)
        reject(new Error('OpenAI Realtime connection failed'))
      },
      { once: true },
    )
  })
  const connection = new OpenAIConnection(socket)
  await connection.send(sessionUpdate(configuration, meta))
  return connection
}

export async function awaitRealtimeReady(
  connection: RealtimeConnection,
  timeoutMs = VALIDATION_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  return Promise.race([
    (async () => {
      for await (const event of connection) {
        if (event.type === 'session.updated')
          return { ok: true, detail: 'OpenAI Realtime accepted the session configuration.' }
        if (event.type === 'error')
          return {
            ok: false,
            detail: text(record(event.error).message) ?? 'OpenAI Realtime rejected the session.',
          }
      }
      return { ok: false, detail: 'OpenAI Realtime closed before the session was ready.' }
    })(),
    new Promise<{ ok: false; detail: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, detail: 'Timed out waiting for OpenAI Realtime.' }), timeoutMs),
    ),
  ])
}

export async function validateOpenAIRealtimeKey(
  apiKey: string,
  model = 'gpt-realtime-2',
  connector: RealtimeConnector = connectOpenAIRealtime,
): Promise<{ ok: boolean; detail: string }> {
  let connection: RealtimeConnection | undefined
  try {
    connection = await connector(
      { apiKey, model, voice: 'cedar' },
      { callId: 'validation', direction: 'inbound', agentHandle: 'validation' },
    )
    return awaitRealtimeReady(connection)
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    await connection?.close().catch(() => {})
  }
}

export function buildRealtimeInstructions(meta: RealtimeCallMeta, additional?: string): string {
  const lines = [
    'You are the configured DeepSeek Harness agent speaking on a live Inkbox phone call.',
    'Use natural, concise spoken replies. Keep most answers to one or two short sentences.',
    `Your Inkbox identity handle is ${meta.agentHandle}.`,
  ]
  if (meta.agentEmail) lines.push(`Your Inkbox email address is ${meta.agentEmail}.`)
  if (meta.agentPhone) lines.push(`Your dedicated phone number is ${meta.agentPhone}.`)
  if (meta.contactName) lines.push(`The caller is ${meta.contactName}.`)
  else if (meta.remotePhoneNumber) lines.push(`The remote phone number is ${meta.remotePhoneNumber}.`)
  if (meta.direction === 'outbound') {
    if (meta.purpose) lines.push(`You placed this call for this purpose: ${meta.purpose}`)
    if (meta.openingMessage) lines.push(`Open the call naturally with: ${meta.openingMessage}`)
    lines.push('Explain why you are calling immediately instead of opening with a generic offer to help.')
  }
  lines.push(
    'Use consult_agent when the caller asks the main agent to perform work or retrieve context.',
    'Use register_post_call_action only for work explicitly deferred until after the call.',
    'Use edit_post_call_action or delete_post_call_action when deferred work changes.',
    'Use hang_up_call when the caller says goodbye or the conversation is complete, then say a brief goodbye.',
  )
  if (additional?.trim()) lines.push(additional.trim())
  return lines.join('\n')
}

export function buildRealtimeGreeting(meta: RealtimeCallMeta): string {
  if (meta.direction === 'outbound') {
    if (meta.openingMessage) return `Say this naturally as your first sentence: ${meta.openingMessage}`
    if (meta.purpose) return `Greet the person and immediately explain why you are calling: ${meta.purpose}`
    return 'Greet the person and immediately explain why you are calling.'
  }
  return `Greet ${meta.contactName ?? 'the caller'} in one short sentence and ask how you can help.`
}

function realtimeTools(): Json[] {
  const tool = (name: string, description: string, properties: Json, required: string[] = []): Json => ({
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  })
  return [
    tool(
      'consult_agent',
      'Ask the main DeepSeek Harness agent to perform work or retrieve context.',
      {
        query: { type: 'string' },
      },
      ['query'],
    ),
    tool(
      'register_post_call_action',
      'Queue work explicitly requested for after the call.',
      {
        action: { type: 'string' },
        details: { type: 'string' },
      },
      ['action'],
    ),
    tool(
      'edit_post_call_action',
      'Change queued after-call work by its one-based index.',
      {
        action_index: { type: 'integer' },
        action: { type: 'string' },
        details: { type: 'string' },
      },
      ['action_index'],
    ),
    tool(
      'delete_post_call_action',
      'Cancel queued after-call work by its one-based index.',
      {
        action_index: { type: 'integer' },
      },
      ['action_index'],
    ),
    tool('hang_up_call', 'End the call after saying a short goodbye.', { reason: { type: 'string' } }),
  ]
}

export function authenticateCallWebSocket(ws: InkboxWebSocket, signingKey: string): boolean {
  const payload = ws.headers.get('x-call-context') ?? ''
  try {
    return verifyWebhook({ payload, headers: Object.fromEntries(ws.headers), secret: signingKey })
  } catch {
    return false
  }
}

export async function loadCallMeta(
  ws: InkboxWebSocket,
  identity: { agentHandle: string; emailAddress?: string | null; phoneNumber?: { number: string } | null },
  stateDir: string,
  client?: Pick<Inkbox, 'calls' | 'contacts'>,
): Promise<RealtimeCallMeta> {
  let context: Json = {}
  try {
    context = record(JSON.parse(ws.headers.get('x-call-context') || '{}'))
  } catch {}
  const url = new URL(ws.url)
  const token = url.searchParams.get('context_token')
  let outbound: Json = {}
  if (token && /^[a-f0-9-]{16,64}$/i.test(token)) {
    const path = join(stateDir, 'call-contexts', `${token}.json`)
    try {
      outbound = record(JSON.parse(await readFile(path, 'utf8')))
      await unlink(path).catch(() => {})
    } catch {}
  }
  const callId = text(context.call_id) ?? text(context.id) ?? 'unknown'
  let remotePhoneNumber = text(context.remote_phone_number)
  let direction: RealtimeCallMeta['direction'] = token ? 'outbound' : 'inbound'
  if (client && callId !== 'unknown') {
    try {
      const call = await client.calls.get(callId)
      remotePhoneNumber ||= call.remotePhoneNumber
      direction = call.direction === 'outbound' ? 'outbound' : 'inbound'
    } catch {
      direction = text(context.direction) === 'outbound' ? 'outbound' : direction
    }
  } else if (text(context.direction) === 'outbound') direction = 'outbound'

  let contactId = text(record(context.contact).id)
  let contactName = text(record(context.contact).name)
  if (client && remotePhoneNumber && (!contactId || !contactName)) {
    try {
      const [contact] = await client.contacts.lookup({ phone: remotePhoneNumber })
      if (contact) {
        contactId ||= contact.id
        contactName ||= contact.preferredName ?? undefined
      }
    } catch {}
  }
  const purpose = text(outbound.purpose)
  const openingMessage = text(outbound.openingMessage)
  return {
    callId,
    ...(contactId ? { contactId } : {}),
    direction,
    ...(remotePhoneNumber ? { remotePhoneNumber } : {}),
    ...(contactName ? { contactName } : {}),
    agentHandle: identity.agentHandle,
    ...(identity.emailAddress ? { agentEmail: identity.emailAddress } : {}),
    ...(identity.phoneNumber?.number ? { agentPhone: identity.phoneNumber.number } : {}),
    ...(purpose ? { purpose } : {}),
    ...(openingMessage ? { openingMessage } : {}),
  }
}

interface BridgeState {
  streamId?: string
  greetingSent: boolean
  responseActive: boolean
  responsePending: boolean
  transcript: TranscriptTurn[]
  actions: PostCallAction[]
  functionCalls: Map<string, { callId: string; name: string; args: string }>
  dispatchedCalls: Set<string>
  toolTasks: Set<Promise<void>>
  hangupArmed: boolean
}

export async function runRealtimeBridge(
  inkbox: InkboxWebSocket,
  openai: RealtimeConnection,
  meta: RealtimeCallMeta,
  callbacks: RealtimeCallbacks,
): Promise<void> {
  const state: BridgeState = {
    greetingSent: false,
    responseActive: false,
    responsePending: false,
    transcript: [],
    actions: [],
    functionCalls: new Map(),
    dispatchedCalls: new Set(),
    toolTasks: new Set(),
    hangupArmed: false,
  }
  await inkbox.accept({
    headers: [
      ['x-use-inkbox-text-to-speech', 'false'],
      ['x-use-inkbox-speech-to-text', 'false'],
    ],
  })

  const fromInkbox = pumpInkbox(inkbox, openai, meta, state)
  const fromOpenAI = pumpOpenAI(openai, inkbox, state, callbacks)
  try {
    await Promise.race([fromInkbox, fromOpenAI])
  } finally {
    await openai.close().catch(() => {})
    await inkbox.close().catch(() => {})
    await Promise.allSettled([fromInkbox, fromOpenAI])
    await Promise.allSettled([...state.toolTasks])
    await callbacks.ended(state.transcript, state.actions)
  }
}

async function pumpInkbox(
  inkbox: InkboxWebSocket,
  openai: RealtimeConnection,
  meta: RealtimeCallMeta,
  state: BridgeState,
): Promise<void> {
  for await (const raw of inkbox) {
    if (typeof raw !== 'string') continue
    let frame: Json
    try {
      frame = record(JSON.parse(raw))
    } catch {
      continue
    }
    const event = text(frame.event)?.toLowerCase()
    if (event === 'start') {
      const streamId = text(frame.stream_id)
      if (streamId) state.streamId = streamId
      if (!state.greetingSent) {
        state.greetingSent = true
        await openai.send({
          type: 'response.create',
          response: { instructions: buildRealtimeGreeting(meta) },
        })
      }
    } else if (event === 'media') {
      if (!state.greetingSent) {
        state.greetingSent = true
        await openai.send({
          type: 'response.create',
          response: { instructions: buildRealtimeGreeting(meta) },
        })
      }
      const payload = text(record(frame.media).payload)
      if (payload) await openai.send({ type: 'input_audio_buffer.append', audio: payload })
    } else if (event === 'stop' || event === 'closed' || event === 'hangup') return
  }
}

async function pumpOpenAI(
  openai: RealtimeConnection,
  inkbox: InkboxWebSocket,
  state: BridgeState,
  callbacks: RealtimeCallbacks,
): Promise<void> {
  for await (const frame of openai) {
    const type = text(frame.type)
    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      const delta = text(frame.delta)
      if (delta)
        await sendInkbox(inkbox, state, { event: 'media', media: { payload: delta, track: 'outbound' } })
    } else if (type === 'response.output_audio.done' || type === 'response.audio.done') {
      await sendInkbox(inkbox, state, { event: 'audio_done' })
      if (state.hangupArmed) {
        await sendInkbox(inkbox, state, { event: 'stop', reason: 'goodbye complete' })
        return
      }
    } else if (type === 'input_audio_buffer.speech_started') {
      state.hangupArmed = false
      await sendInkbox(inkbox, state, { event: 'clear' })
    } else if (
      type === 'response.output_audio_transcript.done' ||
      type === 'response.audio_transcript.done'
    ) {
      await transcript(inkbox, state, 'agent', text(frame.transcript))
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      await transcript(inkbox, state, 'caller', text(frame.transcript))
    } else if (type === 'response.output_item.added') {
      const item = record(frame.item)
      if (item.type === 'function_call') {
        const id = text(item.id) ?? text(frame.item_id)
        if (id)
          state.functionCalls.set(id, {
            callId: text(item.call_id) ?? '',
            name: text(item.name) ?? '',
            args: text(item.arguments) ?? '',
          })
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const id = text(frame.item_id) ?? text(frame.call_id) ?? ''
      const call = state.functionCalls.get(id) ?? { callId: text(frame.call_id) ?? '', name: '', args: '' }
      call.args += text(frame.delta) ?? ''
      state.functionCalls.set(id, call)
    } else if (type === 'response.function_call_arguments.done') {
      const id = text(frame.item_id) ?? text(frame.call_id) ?? ''
      const call = state.functionCalls.get(id) ?? { callId: '', name: '', args: '' }
      call.callId = text(frame.call_id) ?? call.callId
      call.name = text(frame.name) ?? call.name
      call.args = text(frame.arguments) ?? call.args
      await handleToolCall(openai, state, callbacks, call)
    } else if (type === 'response.output_item.done' || type === 'conversation.item.done') {
      const item = record(frame.item)
      if (item.type === 'function_call')
        await handleToolCall(openai, state, callbacks, {
          callId: text(item.call_id) ?? '',
          name: text(item.name) ?? '',
          args: text(item.arguments) ?? '{}',
        })
    } else if (type === 'response.created') state.responseActive = true
    else if (type === 'response.done') {
      state.responseActive = false
      if (state.responsePending) {
        state.responsePending = false
        await requestResponse(openai, state)
      }
    } else if (type === 'error') throw new Error(text(record(frame.error).message) ?? 'OpenAI Realtime error')
  }
}

async function transcript(
  inkbox: InkboxWebSocket,
  state: BridgeState,
  party: TranscriptTurn['party'],
  value: string | undefined,
): Promise<void> {
  if (!value) return
  state.transcript.push({ party, text: value })
  await inkbox.send(
    JSON.stringify({
      event: 'transcript',
      party: party === 'agent' ? 'local' : 'remote',
      text: value,
      is_final: true,
    }),
  )
}

async function sendInkbox(inkbox: InkboxWebSocket, state: BridgeState, value: Json): Promise<void> {
  if (state.streamId) value.stream_id = state.streamId
  await inkbox.send(JSON.stringify(value))
}

async function dispatchTool(
  openai: RealtimeConnection,
  state: BridgeState,
  callbacks: RealtimeCallbacks,
  call: { callId: string; name: string; args: string },
): Promise<void> {
  if (!call.callId || state.dispatchedCalls.has(call.callId)) return
  state.dispatchedCalls.add(call.callId)
  let args: Json = {}
  try {
    args = record(JSON.parse(call.args || '{}'))
  } catch {}
  let output: Json
  if (call.name === 'consult_agent') {
    const query = text(args.query)
    output = query
      ? { status: 'ok', answer: await callbacks.consult(query, state.transcript) }
      : { error: 'missing query' }
  } else if (call.name === 'register_post_call_action') {
    const action = text(args.action)
    if (!action) output = { error: 'missing action' }
    else {
      state.actions.push({ action, details: text(args.details) ?? '' })
      output = { status: 'queued', action_index: state.actions.length }
    }
  } else if (call.name === 'edit_post_call_action') {
    const index = typeof args.action_index === 'number' ? args.action_index - 1 : -1
    const action = state.actions[index]
    if (!action) output = { error: 'invalid action_index' }
    else {
      if (text(args.action)) action.action = text(args.action) as string
      if (typeof args.details === 'string') action.details = args.details
      output = { status: 'updated', action_index: index + 1 }
    }
  } else if (call.name === 'delete_post_call_action') {
    const index = typeof args.action_index === 'number' ? args.action_index - 1 : -1
    if (!state.actions[index]) output = { error: 'invalid action_index' }
    else {
      state.actions.splice(index, 1)
      output = { status: 'deleted', action_index: index + 1 }
    }
  } else if (call.name === 'hang_up_call') {
    state.hangupArmed = true
    output = { status: 'confirm_goodbye', message: 'Say a brief goodbye. The call will end after it plays.' }
  } else output = { error: `Unknown live-call tool: ${call.name}` }

  await openai.send({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) },
  })
  await requestResponse(openai, state)
}

async function handleToolCall(
  openai: RealtimeConnection,
  state: BridgeState,
  callbacks: RealtimeCallbacks,
  call: { callId: string; name: string; args: string },
): Promise<void> {
  if (call.name !== 'consult_agent') {
    await dispatchTool(openai, state, callbacks, call)
    return
  }
  const task = dispatchTool(openai, state, callbacks, call)
  state.toolTasks.add(task)
  void task.finally(() => state.toolTasks.delete(task)).catch(() => {})
}

async function requestResponse(openai: RealtimeConnection, state: BridgeState): Promise<void> {
  if (state.responseActive) {
    state.responsePending = true
    return
  }
  await openai.send({ type: 'response.create' })
}
