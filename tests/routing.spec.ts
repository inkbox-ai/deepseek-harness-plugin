import { describe, expect, it } from 'vitest'
import { routeWebhook } from '../src/routing.js'

const key = 'routing-key-with-enough-entropy-for-tests'

function email(contact = true) {
  return {
    id: 'evt_email',
    event_type: 'message.received',
    data: {
      message: {
        from_address: 'person@example.test',
        subject: 'Hello',
        body: 'Email body',
        thread_id: 'thread-1',
        message_id: '<one@example.test>',
      },
      contacts: contact ? [{ id: 'contact-1', address: 'person@example.test' }] : [],
    },
  }
}

function sms(contact = true, group = false) {
  return {
    id: 'evt_sms',
    event_type: 'text.received',
    data: {
      text_message: {
        sender_phone_number: '+15550001111',
        remote_phone_number: '+15550001111',
        conversation_id: 'sms-conv',
        text: 'Text body',
        recipients: group ? [{}, {}] : null,
      },
      contacts: contact ? [{ id: 'contact-1' }] : [],
    },
  }
}

describe('webhook routing', () => {
  it('converges email and SMS for the same resolved contact', () => {
    expect(routeWebhook(email(), key, false)?.routeKey).toBe('contact:contact-1')
    expect(routeWebhook(sms(), key, false)?.routeKey).toBe('contact:contact-1')
  })

  it('isolates group sessions from one-to-one contact sessions', () => {
    expect(routeWebhook(sms(true, true), key, false)?.routeKey).toBe('group:sms:sms-conv')
    expect(routeWebhook(sms(), key, false)?.routeKey).toBe('contact:contact-1')
  })

  it('never stores raw fallback email or phone PII in a route key', () => {
    const mailRoute = routeWebhook(email(false), key, false)?.routeKey ?? ''
    const smsRoute = routeWebhook(sms(false), key, false)?.routeKey ?? ''
    expect(mailRoute).toMatch(/^peer:/)
    expect(mailRoute).not.toContain('person@example.test')
    expect(smsRoute).not.toContain('+15550001111')
  })

  it('preserves email reply threading and channel', () => {
    const routed = routeWebhook(email(), key, false)
    expect(routed?.target).toEqual({
      channel: 'email',
      to: 'person@example.test',
      subject: 'Re: Hello',
      inReplyToMessageId: '<one@example.test>',
    })
    expect(routed?.prompt).toContain('Email body')
  })

  it('routes iMessage groups by conversation', () => {
    const routed = routeWebhook(
      {
        id: 'evt_im',
        event_type: 'imessage.received',
        data: {
          message: {
            sender_number: '+15550002222',
            conversation_id: 'im-conv',
            is_group: true,
            content: 'Group body',
          },
          contacts: [{ id: 'contact-2' }],
        },
      },
      key,
      false,
    )
    expect(routed).toMatchObject({
      routeKey: 'group:imessage:im-conv',
      channel: 'imessage',
      target: { channel: 'imessage', conversationId: 'im-conv' },
    })
  })

  it('routes iMessage reactions into the same contact session', () => {
    const routed = routeWebhook(
      {
        id: 'evt_reaction',
        event_type: 'imessage.reaction_received',
        data: {
          reaction: {
            remote_number: '+15550002222',
            conversation_id: 'im-conv',
            reaction: 'like',
            target_message_id: 'msg-1',
          },
          contacts: [{ id: 'contact-2' }],
        },
      },
      key,
      false,
    )
    expect(routed?.routeKey).toBe('contact:contact-2')
    expect(routed?.prompt).toContain('Reaction like')
  })

  it('keeps A2A work in its context and suppresses automatic channel replies', () => {
    const routed = routeWebhook(
      {
        id: 'evt_a2a',
        event_type: 'a2a.task.created',
        data: {
          task_id: 'task-1',
          context_id: 'context-1',
          caller: { handle: 'peer' },
          parts: [{ text: 'work' }],
        },
      },
      key,
      false,
    )
    expect(routed).toMatchObject({ routeKey: 'a2a:context-1', channel: 'a2a', target: { channel: 'none' } })
  })

  it('routes post-call reconciliation to a resolved contact', () => {
    const routed = routeWebhook(
      {
        id: 'evt_call',
        event_type: 'call.ended',
        data: {
          call: { id: 'call-1', remote_phone_number: '+15550003333' },
          contacts: [{ id: 'contact-3' }],
        },
      },
      key,
      false,
    )
    expect(routed).toMatchObject({
      routeKey: 'contact:contact-3',
      channel: 'call',
      target: { channel: 'none' },
    })
  })

  it('rejects unknown external events unless explicitly enabled', () => {
    const event = { id: 'evt_external', event_type: 'github.push', data: { ref: 'main' } }
    expect(routeWebhook(event, key, false)).toBeUndefined()
    expect(routeWebhook(event, key, true)).toMatchObject({ channel: 'external', target: { channel: 'none' } })
  })

  it.each([
    [{ event_type: 'text.received', data: {} }],
    [{ id: 'evt', data: {} }],
    [{ id: 'evt', event_type: 'message.received', data: { message: {} } }],
  ])('ignores malformed event %#', (payload) => {
    expect(routeWebhook(payload, key, false)).toBeUndefined()
  })
})
