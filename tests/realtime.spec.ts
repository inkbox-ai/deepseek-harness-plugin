import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InkboxWebSocket } from '@inkbox/sdk/tunnels/connect'
import { describe, expect, it, vi } from 'vitest'
import {
  authenticateCallWebSocket,
  awaitRealtimeReady,
  buildRealtimeInstructions,
  loadCallMeta,
  type RealtimeConnection,
  runRealtimeBridge,
  validateOpenAIRealtimeKey,
} from '../src/realtime.js'

type Json = Record<string, unknown>

class FakeRealtime implements RealtimeConnection {
  readonly sent: Json[] = []
  closed = false
  private finish: (() => void) | undefined

  constructor(
    private readonly events: Array<Json | Promise<Json>>,
    private readonly stayOpen = false,
  ) {}

  async send(event: Json): Promise<void> {
    this.sent.push(event)
  }

  async close(): Promise<void> {
    this.closed = true
    this.finish?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Json> {
    for (const event of this.events) {
      await Promise.resolve()
      yield await event
    }
    if (this.stayOpen && !this.closed)
      await new Promise<void>((resolve) => {
        this.finish = resolve
      })
  }
}

class FakeInkboxSocket implements InkboxWebSocket {
  readonly offeredProtocols: readonly string[] = []
  readonly accepted: unknown[] = []
  readonly sent: string[] = []
  closed = false
  private finish: (() => void) | undefined

  constructor(
    readonly url: string,
    readonly headers: ReadonlyMap<string, string>,
    private readonly frames: string[] = [],
  ) {}

  async accept(options?: unknown): Promise<void> {
    this.accepted.push(options)
  }

  async send(data: string | Buffer): Promise<void> {
    this.sent.push(String(data))
  }

  async close(): Promise<void> {
    this.closed = true
    this.finish?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string | Buffer> {
    for (const frame of this.frames) yield frame
    if (!this.closed)
      await new Promise<void>((resolve) => {
        this.finish = resolve
      })
  }
}

function signedHeaders(context: string, secret: string): Map<string, string> {
  const requestId = 'request-1'
  const timestamp = '1700000000'
  const signature = createHmac('sha256', secret).update(`${requestId}.${timestamp}.${context}`).digest('hex')
  return new Map([
    ['x-call-context', context],
    ['x-inkbox-request-id', requestId],
    ['x-inkbox-timestamp', timestamp],
    ['x-inkbox-signature', `sha256=${signature}`],
  ])
}

describe('OpenAI Realtime call bridge', () => {
  it('authenticates the exact call context and fails closed on malformed signatures', () => {
    const context = JSON.stringify({ call_id: 'call-1', direction: 'inbound' })
    expect(
      authenticateCallWebSocket(
        new FakeInkboxSocket('wss://agent.example.test/phone/media/ws', signedHeaders(context, 'secret')),
        'secret',
      ),
    ).toBe(true)
    expect(
      authenticateCallWebSocket(
        new FakeInkboxSocket(
          'wss://agent.example.test/phone/media/ws',
          new Map([...signedHeaders(context, 'secret'), ['x-inkbox-signature', 'sha256=short']]),
        ),
        'secret',
      ),
    ).toBe(false)
  })

  it('loads one-time outbound context without trusting malformed call metadata', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-call-meta-'))
    const directory = join(stateDir, 'call-contexts')
    await mkdir(directory)
    const token = '12345678-1234-1234-1234-123456789abc'
    const contextPath = join(directory, `${token}.json`)
    await writeFile(contextPath, JSON.stringify({ purpose: 'Confirm the appointment' }))
    const ws = new FakeInkboxSocket(
      `wss://agent.example.test/phone/media/ws?context_token=${token}`,
      new Map([['x-call-context', '{not-json']]),
    )
    await expect(
      loadCallMeta(
        ws,
        {
          agentHandle: 'deepseek-agent',
          emailAddress: 'agent@example.test',
          phoneNumber: { number: '+15551234567' },
        },
        stateDir,
      ),
    ).resolves.toMatchObject({
      direction: 'outbound',
      purpose: 'Confirm the appointment',
      agentHandle: 'deepseek-agent',
    })
    await expect(readFile(contextPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the authoritative call record for direction and resolves the contact for session continuity', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inkbox-call-record-'))
    const context = JSON.stringify({
      call_id: 'call-2',
      direction: 'inbound',
      remote_phone_number: '+15550000003',
    })
    const client = {
      calls: {
        get: vi.fn(async () => ({ direction: 'outbound', remotePhoneNumber: '+15550000003' })),
      },
      contacts: {
        lookup: vi.fn(async () => [{ id: 'contact-2', preferredName: 'Taylor' }]),
      },
    }
    await expect(
      loadCallMeta(
        new FakeInkboxSocket(
          'wss://agent.example.test/phone/media/ws',
          new Map([['x-call-context', context]]),
        ),
        { agentHandle: 'deepseek-agent' },
        stateDir,
        client as never,
      ),
    ).resolves.toMatchObject({
      callId: 'call-2',
      direction: 'outbound',
      remotePhoneNumber: '+15550000003',
      contactId: 'contact-2',
      contactName: 'Taylor',
    })
  })

  it('requires session.updated rather than accepting a socket-open event as successful validation', async () => {
    expect(await awaitRealtimeReady(new FakeRealtime([{ type: 'session.created' }]), 10)).toEqual({
      ok: false,
      detail: 'OpenAI Realtime closed before the session was ready.',
    })
    expect(await awaitRealtimeReady(new FakeRealtime([{ type: 'session.updated' }]), 10)).toEqual({
      ok: true,
      detail: 'OpenAI Realtime accepted the session configuration.',
    })
  })

  it('keeps the provider socket open until asynchronous credential validation completes', async () => {
    let finish: ((value: IteratorResult<Json>) => void) | undefined
    const connection: RealtimeConnection = {
      send: vi.fn(async () => {}),
      close: vi.fn(async () => finish?.({ done: true, value: undefined })),
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Json>>((resolve) => {
            finish = resolve
            setTimeout(() => resolve({ done: false, value: { type: 'session.updated' } }), 5)
          }),
      }),
    }
    const result = await validateOpenAIRealtimeKey('sk-test', 'gpt-realtime-2', async () => connection)
    expect(result.ok).toBe(true)
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it('bridges PCMU audio both ways, relays transcripts, executes tools, and hangs up after goodbye audio', async () => {
    vi.useFakeTimers()
    const inkbox = new FakeInkboxSocket('wss://agent.example.test/phone/media/ws', new Map(), [
      JSON.stringify({ event: 'start', stream_id: 'stream-1' }),
      JSON.stringify({ event: 'media', media: { payload: 'caller-audio' } }),
    ])
    const openai = new FakeRealtime(
      [
        { type: 'response.output_audio.delta', delta: 'agent-audio' },
        { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Please follow up.' },
        { type: 'response.output_audio_transcript.done', transcript: 'I will.' },
        {
          type: 'response.function_call_arguments.done',
          call_id: 'tool-1',
          name: 'consult_agent',
          arguments: JSON.stringify({ query: 'Look up the appointment' }),
        },
        {
          type: 'response.function_call_arguments.done',
          call_id: 'tool-2',
          name: 'register_post_call_action',
          arguments: JSON.stringify({ action: 'Send confirmation', details: 'Email the caller' }),
        },
        {
          type: 'response.function_call_arguments.done',
          call_id: 'tool-3',
          name: 'hang_up_call',
          arguments: '{}',
        },
        { type: 'response.output_audio.done' },
        { type: 'response.done' },
        { type: 'response.done' },
        { type: 'response.done' },
        { type: 'response.done' },
      ],
      true,
    )
    const ended = vi.fn(async () => {})
    const consult = vi.fn(async () => 'The appointment is tomorrow at 3 PM.')
    const bridge = runRealtimeBridge(
      inkbox,
      openai,
      { callId: 'call-1', direction: 'inbound', agentHandle: 'deepseek-agent' },
      { consult, ended },
    )

    await vi.advanceTimersByTimeAsync(2_499)
    expect(inkbox.sent.map((value) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ event: 'stop' }),
    )
    await vi.advanceTimersByTimeAsync(1)
    await bridge
    vi.useRealTimers()

    expect(inkbox.accepted).toEqual([
      {
        headers: [
          ['x-use-inkbox-text-to-speech', 'false'],
          ['x-use-inkbox-speech-to-text', 'false'],
        ],
      },
    ])
    expect(openai.sent).toContainEqual({ type: 'input_audio_buffer.append', audio: 'caller-audio' })
    expect(openai.sent).toContainEqual(expect.objectContaining({ type: 'response.create' }))
    expect(consult).toHaveBeenCalledWith(
      'Look up the appointment',
      expect.arrayContaining([{ party: 'caller', text: 'Please follow up.' }]),
    )
    expect(inkbox.sent.map((value) => JSON.parse(value))).toEqual(
      expect.arrayContaining([
        { event: 'media', media: { payload: 'agent-audio', track: 'outbound' }, stream_id: 'stream-1' },
        { event: 'transcript', party: 'remote', text: 'Please follow up.', is_final: true },
        { event: 'transcript', party: 'local', text: 'I will.', is_final: true },
        { event: 'audio_done', stream_id: 'stream-1' },
        { event: 'stop', reason: 'goodbye complete', stream_id: 'stream-1' },
      ]),
    )
    expect(ended).toHaveBeenCalledWith(
      [
        { party: 'caller', text: 'Please follow up.' },
        { party: 'agent', text: 'I will.' },
      ],
      [{ action: 'Send confirmation', details: 'Email the caller' }],
    )
  })

  it('disarms an automatic hangup when the caller barges in during the goodbye window', async () => {
    vi.useFakeTimers()
    let bargeIn: (() => void) | undefined
    const callerBargeIn = new Promise<Json>((resolve) => {
      bargeIn = () => resolve({ type: 'input_audio_buffer.speech_started' })
    })
    const inkbox = new FakeInkboxSocket('wss://agent.example.test/phone/media/ws', new Map(), [
      JSON.stringify({ event: 'start', stream_id: 'stream-1' }),
    ])
    const openai = new FakeRealtime(
      [
        { type: 'response.created' },
        {
          type: 'response.function_call_arguments.done',
          call_id: 'hangup-arm',
          name: 'hang_up_call',
          arguments: '{}',
        },
        { type: 'response.output_audio.done' },
        callerBargeIn,
        { type: 'response.done' },
        { type: 'response.done' },
      ],
      true,
    )
    const bridge = runRealtimeBridge(
      inkbox,
      openai,
      { callId: 'call-2', direction: 'inbound', agentHandle: 'deepseek-agent' },
      { consult: vi.fn(), ended: vi.fn(async () => {}) },
    )

    await vi.advanceTimersByTimeAsync(2_500)
    bargeIn?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(inkbox.sent.map((value) => JSON.parse(value))).toContainEqual({
      event: 'clear',
      stream_id: 'stream-1',
    })
    expect(inkbox.sent.map((value) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ event: 'stop' }),
    )

    await openai.close()
    await bridge
    vi.useRealTimers()
  })

  it('honors a second hangup tool call after the goodbye and delays teardown to avoid clipping audio', async () => {
    vi.useFakeTimers()
    const inkbox = new FakeInkboxSocket('wss://agent.example.test/phone/media/ws', new Map(), [
      JSON.stringify({ event: 'start', stream_id: 'stream-1' }),
    ])
    const openai = new FakeRealtime(
      [
        {
          type: 'response.function_call_arguments.done',
          call_id: 'hangup-arm',
          name: 'hang_up_call',
          arguments: '{}',
        },
        {
          type: 'response.function_call_arguments.done',
          call_id: 'hangup-confirm',
          name: 'hang_up_call',
          arguments: JSON.stringify({ reason: 'conversation complete' }),
        },
        { type: 'response.done' },
        { type: 'response.done' },
      ],
      true,
    )
    const bridge = runRealtimeBridge(
      inkbox,
      openai,
      { callId: 'call-3', direction: 'outbound', agentHandle: 'deepseek-agent' },
      { consult: vi.fn(), ended: vi.fn(async () => {}) },
    )

    await vi.advanceTimersByTimeAsync(1_999)
    expect(inkbox.sent.map((value) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ event: 'stop' }),
    )
    await vi.advanceTimersByTimeAsync(1)
    await bridge

    expect(inkbox.sent.map((value) => JSON.parse(value))).toContainEqual({
      event: 'stop',
      reason: 'conversation complete',
      stream_id: 'stream-1',
    })
    const outputs = openai.sent
      .filter((event) => event.type === 'conversation.item.create')
      .map((event) => JSON.parse(String((event.item as Json).output)))
    expect(outputs).toEqual([
      expect.objectContaining({ status: 'confirm_goodbye' }),
      expect.objectContaining({ status: 'hangup_requested' }),
    ])
    vi.useRealTimers()
  })

  it('keeps the live voice prompt scoped to spoken call behavior and the configured identity', () => {
    const instructions = buildRealtimeInstructions({
      callId: 'call-1',
      direction: 'outbound',
      agentHandle: 'deepseek-agent',
      purpose: 'Confirm delivery',
    })
    expect(instructions).toContain('DeepSeek Harness agent')
    expect(instructions).toContain('Confirm delivery')
    expect(instructions).toContain('consult_agent')
  })
})
