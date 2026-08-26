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
} from '../src/realtime.js'

type Json = Record<string, unknown>

class FakeRealtime implements RealtimeConnection {
  readonly sent: Json[] = []
  closed = false

  constructor(private readonly events: Json[]) {}

  async send(event: Json): Promise<void> {
    this.sent.push(event)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Json> {
    for (const event of this.events) {
      await Promise.resolve()
      yield event
    }
  }
}

class FakeInkboxSocket implements InkboxWebSocket {
  readonly offeredProtocols: readonly string[] = []
  readonly accepted: unknown[] = []
  readonly sent: string[] = []
  closed = false

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
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string | Buffer> {
    for (const frame of this.frames) yield frame
    while (!this.closed) await new Promise((resolve) => setTimeout(resolve, 1))
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

  it('bridges PCMU audio both ways, relays transcripts, executes tools, and hangs up after goodbye audio', async () => {
    const inkbox = new FakeInkboxSocket('wss://agent.example.test/phone/media/ws', new Map(), [
      JSON.stringify({ event: 'start', stream_id: 'stream-1' }),
      JSON.stringify({ event: 'media', media: { payload: 'caller-audio' } }),
    ])
    const openai = new FakeRealtime([
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
    ])
    const ended = vi.fn(async () => {})
    const consult = vi.fn(async () => 'The appointment is tomorrow at 3 PM.')
    await runRealtimeBridge(
      inkbox,
      openai,
      { callId: 'call-1', direction: 'inbound', agentHandle: 'deepseek-agent' },
      { consult, ended },
    )

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
