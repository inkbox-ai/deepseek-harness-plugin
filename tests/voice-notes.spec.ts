// tests/voice-notes.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pollVoiceNote,
  unconfirmedVoiceNoteIds,
  type VoiceEvent,
  VoiceNoteInbox,
  VoiceNoteNotAdmitted,
  voiceNoteContext,
} from '../src/voice-notes.js'

const received = (family = 'imessage', statuses = ['pending']): VoiceEvent => ({
  id: 'event-received',
  event_type: `${family}.received`,
  data: {
    [family === 'text' ? 'text_message' : 'message']: {
      id: 'message-1',
      direction: 'inbound',
      conversation_id: 'conversation-1',
      agent_identity_id: 'agent-1',
      content: 'Original caption',
      media: statuses.map((status, index) => ({
        id: `media-${index}`,
        url: 'https://example.com/voice.wav',
        content_type: 'audio/wav',
        transcription: {
          status,
          text: status === 'completed' ? 'Move the review to Thursday.' : null,
        },
      })),
    },
  },
})
const completion = (family = 'imessage', statuses = ['completed']): VoiceEvent => ({
  data: { ...received(family, statuses).data, channel: family, message_id: 'message-1' },
  id: 'different-event-id',
  event_type: 'message.transcription_finished',
})
let directory: string
let inboxes: VoiceNoteInbox[]
beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'voice-notes-'))
  inboxes = []
})
afterEach(() => {
  inboxes.forEach((inbox) => {
    inbox.close()
  })
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function setup(
  options: { poll?: (event: VoiceEvent) => Promise<VoiceEvent | undefined>; path?: string } = {},
) {
  const deliver = vi.fn(async (_event: VoiceEvent) => {}),
    poll = vi.fn(options.poll ?? (async () => undefined))
  const inbox = new VoiceNoteInbox({
    path: options.path ?? join(directory, 'voice.json'),
    poll,
    deliver,
    warn: vi.fn(),
  })
  inboxes.push(inbox)
  return { inbox, deliver, poll }
}

describe('voice-note delivery', () => {
  it.each(['text', 'imessage', 'whatsapp'])(
    'waits nonblocking for %s completion and wakes once',
    async (family) => {
      const { inbox, deliver, poll } = setup()
      const original = received(family)
      expect(await inbox.accept(original)).toBe(true)
      expect(deliver).not.toHaveBeenCalled()
      const wrongId = completion(family)
      wrongId.data.message_id = 'unrelated-source'
      expect(await inbox.accept(wrongId)).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(deliver).not.toHaveBeenCalled()
      await inbox.accept(completion(family))
      await vi.advanceTimersByTimeAsync(0)
      expect(deliver).toHaveBeenCalledTimes(1)
      const message = deliver.mock.calls[0]?.[0].data[family === 'text' ? 'text_message' : 'message']
      expect(message.content).toBe('Original caption')
      expect(voiceNoteContext(message)).toContain('[Voice note 1 — automatically transcribed]')
      expect(message.media[0].url).toBe(
        original.data[family === 'text' ? 'text_message' : 'message'].media[0].url,
      )
      await inbox.accept(completion(family))
      await inbox.accept(received(family))
      await vi.advanceTimersByTimeAsync(70_000)
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(poll).not.toHaveBeenCalled()
    },
  )
  it('uses an early callback without turning it into a standalone wake', async () => {
    const { inbox, deliver } = setup()
    await inbox.accept(completion())
    expect(deliver).not.toHaveBeenCalled()
    await inbox.accept(received())
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('polls once at 60 seconds, then falls back without waiting for a late callback', async () => {
    const { inbox, deliver, poll } = setup()
    await inbox.accept(received())
    await vi.advanceTimersByTimeAsync(59_999)
    expect(poll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(voiceNoteContext(deliver.mock.calls[0]?.[0].data.message)).toContain(
      'Process the original attachment as usual',
    )
    await inbox.accept(completion())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('uses a completed poll and bounds an unresponsive poll', async () => {
    const resolved = setup({ poll: async () => completion() })
    await resolved.inbox.accept(received())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resolved.deliver.mock.calls[0]?.[0].data.message.media[0].transcription.status).toBe('completed')
    const hung = setup({ path: join(directory, 'hung.json'), poll: () => new Promise(() => {}) })
    await hung.inbox.accept(received())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hung.deliver).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(hung.deliver).toHaveBeenCalledTimes(1)
  })
  it('does not overwrite a completion arriving during the fallback poll', async () => {
    let resolve!: (event: VoiceEvent) => void
    const { inbox, deliver } = setup({
      poll: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    await inbox.accept(received())
    await vi.advanceTimersByTimeAsync(60_000)
    await inbox.accept(completion())
    resolve(received())
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0].data.message.media[0].transcription.status).toBe('completed')
  })
  it('waits for every pending attachment and tolerates failed results', async () => {
    const { inbox, deliver } = setup()
    await inbox.accept(received('imessage', ['pending', 'pending']))
    await inbox.accept(completion('imessage', ['completed', 'pending']))
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
    await inbox.accept(completion('imessage', ['completed', 'failed']))
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('does not delay legacy messages or accept a mismatched completion', async () => {
    const { inbox, deliver } = setup()
    const legacy = received()
    delete legacy.data.message.media[0].transcription
    expect(await inbox.accept(legacy)).toBe(false)
    await inbox.accept(received())
    const wrong = completion()
    wrong.data.message.conversation_id = 'another-conversation'
    await inbox.accept(wrong)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
  })
  it('resumes the original deadline after restart and cancels stopped timers', async () => {
    const path = join(directory, 'restart.json')
    const first = setup({ path })
    await first.inbox.accept(received())
    await vi.advanceTimersByTimeAsync(45_000)
    first.inbox.close()
    const second = setup({ path })
    second.inbox.recover()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(first.deliver).not.toHaveBeenCalled()
    expect(second.poll).toHaveBeenCalledTimes(1)
    expect(second.deliver).toHaveBeenCalledTimes(1)
  })
  it('does not replay an ambiguous handoff after restart', async () => {
    const current = setup()
    current.deliver.mockRejectedValueOnce(new Error('host unavailable'))
    await current.inbox.accept(received())
    await current.inbox.accept(completion())
    await vi.advanceTimersByTimeAsync(0)
    expect(unconfirmedVoiceNoteIds(join(directory, 'voice.json'))).toEqual(['imessage:message-1'])
    current.inbox.close()
    const recovered = setup()
    const refreshed = received()
    refreshed.data.message.media = []
    expect(await recovered.inbox.accept(refreshed)).toBe(true)
    recovered.inbox.recover()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recovered.deliver).not.toHaveBeenCalled()
  })
  it('retries a transient host admission failure without polling a second time', async () => {
    const { inbox, deliver, poll } = setup()
    deliver.mockRejectedValueOnce(new VoiceNoteNotAdmitted('host temporarily unavailable'))
    await inbox.accept(received())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(poll).toHaveBeenCalledTimes(1)
    await inbox.accept(completion())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deliver).toHaveBeenCalledTimes(2)
  })
  it('retains the one-poll decision across restart after failed admission', async () => {
    const path = join(directory, 'poll-recovery.json')
    const first = setup({ path })
    first.deliver.mockRejectedValueOnce(new VoiceNoteNotAdmitted('host temporarily unavailable'))
    await first.inbox.accept(received())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first.poll).toHaveBeenCalledTimes(1)
    first.inbox.close()
    const second = setup({ path })
    second.inbox.recover()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(second.deliver).toHaveBeenCalledTimes(1)
    expect(second.poll).not.toHaveBeenCalled()
  })
  it('polls the authenticated message read once without dropping raw metadata', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(completion('text').data.text_message)))
    const event = await pollVoiceNote(received('text'), {
      apiKey: 'synthetic-key',
      baseUrl: 'https://example.com',
      identity: async () => ({ id: 'agent-1', phoneNumber: { id: 'phone-1' } }),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://example.com/api/v1/phone/numbers/phone-1/texts/message-1')
    expect(event?.data.text_message.media[0].transcription.status).toBe('completed')
  })
})

describe('managed transcription resolution', () => {
  it('does not start a second wait for a managed fallback', async () => {
    vi.stubEnv('INKBOX_HOSTED_MODE', '1')
    const path = join(mkdtempSync(join(tmpdir(), 'voice-managed-')), 'voice.json')
    const poll = vi.fn(),
      deliver = vi.fn()
    const inbox = new VoiceNoteInbox({ path, poll, deliver, warn: vi.fn() })
    try {
      expect(await inbox.accept(received())).toBe(false)
      await vi.advanceTimersByTimeAsync(70_000)
      expect(poll).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
    } finally {
      inbox.close()
      vi.unstubAllEnvs()
      rmSync(path, { force: true })
    }
  })
})

it('does not label real video as an unavailable voice note', () => {
  const message = received().data.message
  message.media[0].transcription = { status: 'skipped', error_code: 'not_audio' }
  expect(voiceNoteContext(message)).toBe('')
  message.media[0].transcription.error_code = 'unsupported_audio'
  expect(voiceNoteContext(message)).toContain('transcript unavailable')
})

describe('Slack voice notes', () => {
  const slackReceived = (
    statuses = ['pending'],
    eventType = 'slack.dm_received',
    extra: Record<string, unknown> = {},
  ): VoiceEvent => ({
    id: 'slack-event-1',
    event_type: eventType,
    data: {
      identity_id: 'agent-1',
      connection_id: 'connection-1',
      workspace_id: 'T1',
      conversation_id: 'D1',
      actor_id: 'U1',
      message_ts: '1770000000.000100',
      thread_ts: null,
      message_id: 'slack-message-1',
      message_kinds: ['dm'],
      event: {
        type: 'message',
        text: 'Original caption',
        files: statuses.map((status, index) => ({
          id: `F${index}`,
          name: 'voice.m4a',
          mimetype: 'audio/mp4',
          transcription: {
            status,
            text: status === 'completed' ? 'Move the review to Thursday.' : null,
            error_code: status === 'failed' ? 'transcription_failed' : null,
          },
        })),
      },
      ...extra,
    },
  })
  const slackCompletion = (statuses = ['completed'], extra: Record<string, unknown> = {}): VoiceEvent => ({
    id: 'slack-finished-1',
    event_type: 'message.transcription_finished',
    data: { ...slackReceived(statuses, 'slack.dm_received', extra).data, channel: 'slack' },
  })

  it.each([
    'slack.dm_received',
    'slack.group_dm_received',
    'slack.channel_message_received',
    'slack.mention_received',
    'slack.thread_reply_received',
  ])('waits for the %s completion by message_id and wakes once', async (eventType) => {
    const { inbox, deliver, poll } = setup()
    expect(await inbox.accept(slackReceived(['pending'], eventType))).toBe(true)
    expect(deliver).not.toHaveBeenCalled()
    expect(await inbox.accept(slackCompletion(['completed'], { connection_id: 'other' }))).toBe(true)
    expect(await inbox.accept(slackCompletion(['completed'], { message_id: 'another-message' }))).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).not.toHaveBeenCalled()
    await inbox.accept(slackCompletion())
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    const delivered = deliver.mock.calls[0]?.[0] as VoiceEvent
    expect(delivered.event_type).toBe(eventType)
    expect(delivered.data.event.text).toBe('Original caption')
    expect(delivered.data.event.files[0].name).toBe('voice.m4a')
    expect(voiceNoteContext(delivered.data.event)).toBe(
      '[Voice note 1 — automatically transcribed]\nMove the review to Thursday.',
    )
    await inbox.accept(slackCompletion())
    await inbox.accept(slackReceived(['pending'], eventType))
    await vi.advanceTimersByTimeAsync(70_000)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(poll).not.toHaveBeenCalled()
  })
  it('uses an early Slack completion without a standalone wake', async () => {
    const { inbox, deliver } = setup()
    await inbox.accept(slackCompletion())
    expect(deliver).not.toHaveBeenCalled()
    await inbox.accept(slackReceived())
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0].data.event.files[0].transcription.status).toBe('completed')
  })
  it('polls once at 60 seconds and uses the polled Slack result', async () => {
    const { inbox, deliver, poll } = setup({ poll: async () => slackCompletion() })
    await inbox.accept(slackReceived())
    await vi.advanceTimersByTimeAsync(59_999)
    expect(poll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(voiceNoteContext(deliver.mock.calls[0]?.[0].data.event)).toContain('automatically transcribed')
    await inbox.accept(slackCompletion())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
  it('falls back to the original Slack attachment after an empty poll', async () => {
    const { inbox, deliver, poll } = setup()
    await inbox.accept(slackReceived())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(voiceNoteContext(deliver.mock.calls[0]?.[0].data.event)).toBe(
      '[Voice note 1 — transcript unavailable] Process the original attachment as usual.',
    )
  })
  it('delivers failed and skipped Slack transcripts as the original attachment', async () => {
    const { inbox, deliver, poll } = setup()
    await inbox.accept(slackReceived(['pending', 'pending', 'pending']))
    await inbox.accept(slackCompletion(['failed', 'skipped', 'completed']))
    await vi.advanceTimersByTimeAsync(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(poll).not.toHaveBeenCalled()
    expect(voiceNoteContext(deliver.mock.calls[0]?.[0].data.event)).toBe(
      '[Voice note 1 — transcript unavailable] Process the original attachment as usual.\n\n' +
        '[Voice note 2 — transcript unavailable] Process the original attachment as usual.\n\n' +
        '[Voice note 3 — automatically transcribed]\nMove the review to Thursday.',
    )
  })
  it('labels an empty Slack transcript as no speech detected', async () => {
    const { inbox, deliver } = setup()
    await inbox.accept(slackReceived())
    const empty = slackCompletion()
    empty.data.event.files[0].transcription.text = '  '
    await inbox.accept(empty)
    await vi.advanceTimersByTimeAsync(0)
    expect(voiceNoteContext(deliver.mock.calls[0]?.[0].data.event)).toBe(
      '[Voice note 1 — automatically transcribed] No speech detected.',
    )
  })
  it('resumes the original Slack deadline after restart', async () => {
    const path = join(directory, 'slack-restart.json')
    const first = setup({ path })
    await first.inbox.accept(slackReceived())
    await vi.advanceTimersByTimeAsync(45_000)
    first.inbox.close()
    const second = setup({ path })
    second.inbox.recover()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(second.poll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(first.deliver).not.toHaveBeenCalled()
    expect(second.poll).toHaveBeenCalledTimes(1)
    expect(second.deliver).toHaveBeenCalledTimes(1)
    expect(second.deliver.mock.calls[0]?.[0].data.message_id).toBe('slack-message-1')
  })
  it('retries a temporary Slack admission failure at the fixed delay and keeps a final one', async () => {
    const transient = setup()
    transient.deliver.mockRejectedValueOnce(new VoiceNoteNotAdmitted('Slack is temporarily unavailable.'))
    await transient.inbox.accept(slackReceived(['completed']))
    expect(transient.deliver).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(transient.deliver).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(transient.deliver).toHaveBeenCalledTimes(2)
    const path = join(directory, 'slack-final.json')
    const final = setup({ path })
    final.deliver.mockRejectedValueOnce(new Error('Slack connection is not connected to this identity.'))
    await final.inbox.accept(slackReceived(['completed']))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(final.deliver).toHaveBeenCalledTimes(1)
    expect(unconfirmedVoiceNoteIds(path)).toEqual(['slack:slack-message-1'])
  })
  it('leaves Slack messages without a transcript or retained ID on the usual path', async () => {
    const { inbox, deliver } = setup()
    const legacy = slackReceived()
    delete legacy.data.event.files[0].transcription
    expect(await inbox.accept(legacy)).toBe(false)
    const unretained = slackReceived()
    delete unretained.data.message_id
    expect(await inbox.accept(unretained)).toBe(false)
    expect(await inbox.accept(slackReceived(['pending'], 'slack.message_updated'))).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })
  it('polls the retained Slack message by message_id', async () => {
    const files = slackCompletion().data.event.files
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ id: 'slack-message-1', connection_id: 'connection-1', conversation_id: 'D1', files }],
          next_cursor: null,
        }),
      ),
    )
    const identity = vi.fn()
    const event = await pollVoiceNote(slackReceived(), {
      apiKey: 'synthetic-key',
      baseUrl: 'https://example.com/',
      identity,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://example.com/api/v1/slack/connections/connection-1/archive/messages?message_id=slack-message-1',
    )
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { 'X-Api-Key': 'synthetic-key' } })
    expect(identity).not.toHaveBeenCalled()
    expect(event?.data.event.files[0].transcription.status).toBe('completed')
    expect(event?.data.event.text).toBe('Original caption')
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'slack-message-1', connection_id: 'other', files }] })),
    )
    expect(await pollVoiceNote(slackReceived(), { apiKey: 'synthetic-key', identity })).toBeUndefined()
  })
})
