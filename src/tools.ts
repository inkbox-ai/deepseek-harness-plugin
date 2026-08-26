import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterPropertySpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { AgentIdentity, Inkbox } from '@inkbox/sdk'
import { CallOrigin, type VoicemailDetection } from '@inkbox/sdk'
import { toIMessagePlainText } from './imessage.js'
import type { InkboxRuntime } from './runtime.js'

type Args = Record<string, unknown>
type Params = Record<string, ParameterPropertySpec>

const stringOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const s = (description: string, required = false): ParameterPropertySpec => ({
  type: 'string',
  description,
  ...(required ? { required: true } : {}),
})
const n = (description: string): ParameterPropertySpec => ({ type: 'integer', description })
const b = (description: string): ParameterPropertySpec => ({ type: 'boolean', description })
const strings = (description: string, required = false): ParameterPropertySpec => ({
  type: 'array',
  description,
  items: { type: 'string' },
  ...(required ? { required: true } : {}),
})
const objects = (description: string): ParameterPropertySpec => ({
  type: 'array',
  description,
  items: { type: 'object', additionalProperties: true, properties: {} },
})

function json(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (nested instanceof Date ? nested.toISOString() : nested), 2)
}

function presentError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

async function approve(ctx: Context, exec: ToolRunContext, toolName: string, reason: string): Promise<void> {
  if (exec.signal.aborted) throw exec.signal.reason ?? new Error('Tool call cancelled')
  if (exec.agent === undefined) throw new Error(`${toolName} requires an active Harness agent turn`)
  const outcome = await ctx.approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') throw new Error(`${toolName} was not approved (${outcome})`)
}

const readNames = new Set([
  'inkbox_whoami',
  'inkbox_lookup_contact',
  'inkbox_list_contacts',
  'inkbox_get_contact',
  'inkbox_list_text_conversations',
  'inkbox_get_text_conversation',
  'inkbox_list_texts',
  'inkbox_get_text',
  'inkbox_imessage_triage_number',
  'inkbox_list_imessage_assignments',
  'inkbox_list_imessage_conversations',
  'inkbox_get_imessage_conversation',
  'inkbox_a2a_check',
  'inkbox_list_a2a_tasks',
  'inkbox_list_a2a_messages',
  'inkbox_list_a2a_sent_tasks',
  'inkbox_get_a2a_sent_task',
])

interface CatalogEntry {
  name: string
  description: string
  parameters: Params
  approval?: (args: Args) => string
}

export const TOOL_CATALOG: readonly CatalogEntry[] = [
  {
    name: 'inkbox_whoami',
    description: 'Show the authenticated Inkbox identity and its configured communication channels.',
    parameters: {},
  },
  {
    name: 'inkbox_lookup_contact',
    description: 'Reverse-lookup contacts by one exact or partial email or phone filter.',
    parameters: {
      email: s('Exact email.'),
      phone: s('Exact E.164 phone.'),
      emailDomain: s('Email domain.'),
      emailContains: s('Email substring.'),
      phoneContains: s('Phone substring.'),
    },
  },
  {
    name: 'inkbox_list_contacts',
    description: 'List organization contacts, optionally filtered by free-text search.',
    parameters: {
      q: s('Search query.'),
      order: s('recent or name.'),
      limit: n('Maximum results.'),
      offset: n('Pagination offset.'),
    },
  },
  {
    name: 'inkbox_get_contact',
    description: 'Get one contact by UUID.',
    parameters: { contactId: s('Contact UUID.', true) },
  },
  {
    name: 'inkbox_create_contact',
    description: 'Create an organization contact.',
    parameters: {
      preferredName: s('Preferred name.'),
      givenName: s('Given name.'),
      familyName: s('Family name.'),
      companyName: s('Company.'),
      jobTitle: s('Job title.'),
      notes: s('Notes.'),
      emails: objects('Email records with value, label, and isPrimary.'),
      phones: objects('Phone records with value, label, and isPrimary.'),
    },
  },
  {
    name: 'inkbox_update_contact',
    description: 'Update fields on a contact; omitted fields remain unchanged.',
    parameters: {
      contactId: s('Contact UUID.', true),
      preferredName: s('Preferred name.'),
      givenName: s('Given name.'),
      familyName: s('Family name.'),
      companyName: s('Company.'),
      jobTitle: s('Job title.'),
      notes: s('Notes.'),
      emails: objects('Replacement email records.'),
      phones: objects('Replacement phone records.'),
    },
  },
  {
    name: 'inkbox_delete_contact',
    description: 'Delete a contact by UUID.',
    parameters: { contactId: s('Contact UUID.', true) },
    approval: (a) => `Delete contact ${a.contactId as string}`,
  },
  {
    name: 'inkbox_send_email',
    description: 'Send email from the configured identity, including CC, BCC, HTML, and reply threading.',
    parameters: {
      to: strings('Primary recipient email addresses.', true),
      subject: s('Subject.', true),
      bodyText: s('Plain-text body.'),
      bodyHtml: s('HTML body.'),
      cc: strings('CC addresses.'),
      bcc: strings('BCC addresses.'),
      inReplyToMessageId: s('RFC 5322 Message-ID to reply to.'),
    },
    approval: (a) => `Send email to ${(a.to as string[]).join(', ')}: ${a.subject as string}`,
  },
  {
    name: 'inkbox_send_sms',
    description: 'Send SMS/MMS to E.164 recipients or reply in an existing conversation.',
    parameters: {
      to: strings('One or more E.164 recipients.'),
      conversationId: s('Existing conversation UUID.'),
      text: s('Message body.'),
      mediaUrls: strings('MMS media URLs.'),
    },
    approval: (a) =>
      `Send SMS to ${String(a.conversationId ?? (a.to as string[] | undefined)?.join(', ') ?? 'recipient')}`,
  },
  {
    name: 'inkbox_list_text_conversations',
    description: 'List SMS/MMS conversations for this identity.',
    parameters: {
      limit: n('Maximum results.'),
      offset: n('Pagination offset.'),
      isBlocked: b('Blocked-state filter.'),
      includeGroups: b('Include group conversations.'),
    },
  },
  {
    name: 'inkbox_get_text_conversation',
    description: 'Get messages in one SMS/MMS conversation.',
    parameters: {
      conversationKey: s('Remote E.164 number or conversation UUID.', true),
      limit: n('Maximum results.'),
      offset: n('Pagination offset.'),
    },
  },
  {
    name: 'inkbox_list_texts',
    description: 'List SMS/MMS messages for this identity.',
    parameters: {
      limit: n('Maximum results.'),
      offset: n('Pagination offset.'),
      isRead: b('Read-state filter.'),
      isBlocked: b('Blocked-state filter.'),
    },
  },
  {
    name: 'inkbox_get_text',
    description: 'Get one SMS/MMS message by UUID.',
    parameters: { textId: s('Message UUID.', true) },
  },
  {
    name: 'inkbox_mark_text_read',
    description: 'Mark one SMS/MMS message read.',
    parameters: { textId: s('Message UUID.', true) },
  },
  {
    name: 'inkbox_mark_text_conversation_read',
    description: 'Mark every message in one SMS/MMS conversation read.',
    parameters: { conversationKey: s('Remote E.164 number or conversation UUID.', true) },
  },
  {
    name: 'inkbox_imessage_triage_number',
    description: 'Show the shared iMessage triage number and connection instructions.',
    parameters: {},
  },
  {
    name: 'inkbox_send_imessage',
    description: 'Send an iMessage to recipients or reply in an existing conversation.',
    parameters: {
      to: strings('One or more E.164 recipients.'),
      conversationId: s('Existing conversation UUID.'),
      text: s('Message body.'),
      mediaUrls: strings('Media URLs.'),
      sendStyle: s('Optional expressive send style.'),
    },
    approval: (a) =>
      `Send iMessage to ${String(a.conversationId ?? (a.to as string[] | undefined)?.join(', ') ?? 'recipient')}`,
  },
  {
    name: 'inkbox_list_imessage_assignments',
    description: 'List recipients currently connected to this identity on iMessage.',
    parameters: { limit: n('Maximum results.'), offset: n('Pagination offset.') },
  },
  {
    name: 'inkbox_list_imessage_conversations',
    description: 'List iMessage conversations for this identity.',
    parameters: {
      limit: n('Maximum results.'),
      offset: n('Pagination offset.'),
      isBlocked: b('Blocked-state filter.'),
      includeGroups: b('Include groups.'),
    },
  },
  {
    name: 'inkbox_get_imessage_conversation',
    description: 'Get one iMessage conversation and its messages.',
    parameters: { conversationId: s('Conversation UUID.', true) },
  },
  {
    name: 'inkbox_send_imessage_reaction',
    description: 'React to an inbound iMessage.',
    parameters: {
      messageId: s('Message UUID.', true),
      reaction: s('Reaction type.', true),
      partIndex: n('Message part index.'),
    },
    approval: (a) => `React to iMessage ${a.messageId as string}`,
  },
  {
    name: 'inkbox_mark_imessage_conversation_read',
    description: 'Send a read receipt and mark a one-to-one iMessage conversation read.',
    parameters: { conversationId: s('Conversation UUID.', true) },
  },
  {
    name: 'inkbox_place_call',
    description: 'Place an outbound voice call and give the voice agent a concrete task brief.',
    parameters: {
      toNumber: s('E.164 destination.', true),
      reason: s('Task brief for the call.', true),
      origination: s('dedicated_number, shared_imessage_number, or dedicated_imessage_number.'),
      voicemailDetection: s('enabled or disabled.'),
    },
    approval: (a) => `Place a voice call to ${a.toNumber as string}: ${a.reason as string}`,
  },
  {
    name: 'inkbox_a2a_call',
    description: 'Send a task to an A2A 1.0 Agent Card.',
    parameters: {
      cardUrl: s('Agent Card URL.', true),
      text: s('Task text.', true),
      contextId: s('Context to continue.'),
      taskId: s('Task requesting more input.'),
      messageId: s('Stable idempotency id.'),
    },
    approval: (a) => `Send A2A task to ${a.cardUrl as string}`,
  },
  {
    name: 'inkbox_a2a_check',
    description: 'Fetch an outbound A2A task or wait for a meaningful state.',
    parameters: {
      cardUrl: s('Agent Card URL.', true),
      taskId: s('Remote task UUID.', true),
      wait: b('Wait for a final or input-required state.'),
    },
  },
  {
    name: 'inkbox_a2a_reply',
    description: 'Reply to a remote A2A task that requested more input.',
    parameters: {
      cardUrl: s('Agent Card URL.', true),
      taskId: s('Remote task UUID.', true),
      text: s('Reply text.', true),
      messageId: s('Stable idempotency id.'),
    },
    approval: (a) => `Reply to A2A task ${a.taskId as string}`,
  },
  {
    name: 'inkbox_a2a_complete',
    description: 'Complete the active inbound A2A task with a final answer.',
    parameters: { taskId: s('Inbound task UUID.', true), text: s('Final answer.', true) },
  },
  {
    name: 'inkbox_a2a_ask_caller',
    description: 'Ask the caller for input on an inbound A2A task.',
    parameters: { taskId: s('Inbound task UUID.', true), text: s('Question.', true) },
  },
  {
    name: 'inkbox_a2a_fail',
    description: 'Fail an inbound A2A task with a reason.',
    parameters: { taskId: s('Inbound task UUID.', true), reason: s('Failure reason.', true) },
  },
  {
    name: 'inkbox_list_a2a_tasks',
    description: 'List inbound A2A task history with participant, state, context, query, and cursor filters.',
    parameters: {
      requesterHandle: s('Caller handle.'),
      workerHandle: s('Worker handle.'),
      state: s('Task state.'),
      contextId: s('Context UUID.'),
      query: s('Search query.'),
      since: s('ISO timestamp lower bound.'),
      cursor: s('Next cursor.'),
      limit: n('Maximum results.'),
    },
  },
  {
    name: 'inkbox_list_a2a_messages',
    description: 'List inbound and outbound A2A message history.',
    parameters: {
      direction: s('inbound, outbound, or both.'),
      requesterHandle: s('Caller handle.'),
      workerHandle: s('Worker handle.'),
      taskId: s('Task UUID.'),
      contextId: s('Context UUID.'),
      role: s('caller or agent.'),
      query: s('Search query.'),
      since: s('ISO timestamp lower bound.'),
      cursor: s('Next cursor.'),
      limit: n('Maximum results.'),
    },
  },
  {
    name: 'inkbox_list_a2a_sent_tasks',
    description: 'List A2A tasks sent by this identity.',
    parameters: {
      requesterHandle: s('Caller handle.'),
      workerHandle: s('Worker handle.'),
      state: s('Task state.'),
      contextId: s('Context UUID.'),
      query: s('Search query.'),
      since: s('ISO timestamp lower bound.'),
      cursor: s('Next cursor.'),
      limit: n('Maximum results.'),
    },
  },
  {
    name: 'inkbox_get_a2a_sent_task',
    description: 'Get a full A2A task sent by this identity.',
    parameters: { taskId: s('Task UUID.', true) },
  },
]

function compact<T extends Args>(args: T): T {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) as T
}

async function execute(
  name: string,
  args: Args,
  client: Inkbox,
  identity: AgentIdentity,
  runtime: InkboxRuntime,
): Promise<unknown> {
  switch (name) {
    case 'inkbox_whoami':
      return {
        auth: await client.whoami(),
        identity: {
          id: identity.id,
          agentHandle: identity.agentHandle,
          displayName: identity.displayName,
          emailAddress: identity.emailAddress,
          phoneNumber: identity.phoneNumber,
          imessageEnabled: identity.imessageEnabled,
          imessageNumber: identity.imessageNumber,
          tunnel: identity.tunnel,
        },
      }
    case 'inkbox_lookup_contact':
      return client.contacts.lookup(compact(args))
    case 'inkbox_list_contacts':
      return client.contacts.list(compact(args))
    case 'inkbox_get_contact':
      return client.contacts.get(args.contactId as string)
    case 'inkbox_create_contact':
      return client.contacts.create(compact(args))
    case 'inkbox_update_contact': {
      const { contactId, ...changes } = args
      return client.contacts.update(contactId as string, compact(changes))
    }
    case 'inkbox_delete_contact':
      await client.contacts.delete(args.contactId as string)
      return { deleted: true, contactId: args.contactId }
    case 'inkbox_send_email':
      return identity.sendEmail(compact(args) as never)
    case 'inkbox_send_sms': {
      const to = args.to as string[] | undefined
      return identity.sendText(compact({ ...args, to: to?.length === 1 ? to[0] : to }) as never)
    }
    case 'inkbox_list_text_conversations':
      return identity.listTextConversations(compact(args))
    case 'inkbox_get_text_conversation':
      return identity.getTextConversation(
        args.conversationKey as string,
        compact({ limit: args.limit, offset: args.offset }) as never,
      )
    case 'inkbox_list_texts':
      return identity.listTexts(compact(args))
    case 'inkbox_get_text':
      return identity.getText(args.textId as string)
    case 'inkbox_mark_text_read':
      return identity.markTextRead(args.textId as string)
    case 'inkbox_mark_text_conversation_read':
      return identity.markTextConversationRead(args.conversationKey as string)
    case 'inkbox_imessage_triage_number':
      return client.imessages.getTriageNumber()
    case 'inkbox_send_imessage': {
      const to = args.to as string[] | undefined
      return identity.sendIMessage(
        compact({
          ...args,
          ...(typeof args.text === 'string' ? { text: toIMessagePlainText(args.text) } : {}),
          to: to?.length === 1 ? to[0] : to,
        }) as never,
      )
    }
    case 'inkbox_list_imessage_assignments':
      return identity.listIMessageAssignments(compact(args))
    case 'inkbox_list_imessage_conversations':
      return identity.listIMessageConversations(compact(args))
    case 'inkbox_get_imessage_conversation':
      return identity.getIMessageConversation(args.conversationId as string)
    case 'inkbox_send_imessage_reaction':
      return identity.sendIMessageReaction(compact(args) as never)
    case 'inkbox_mark_imessage_conversation_read':
      return identity.markIMessageConversationRead(args.conversationId as string)
    case 'inkbox_place_call':
      return runtime.placeCall({
        toNumber: args.toNumber as string,
        reason: args.reason as string,
        origination: (args.origination as CallOrigin | undefined) ?? CallOrigin.DEDICATED_NUMBER,
        ...(args.voicemailDetection
          ? { voicemailDetection: args.voicemailDetection as VoicemailDetection }
          : {}),
      })
    case 'inkbox_a2a_call': {
      const a2a = await identity.a2aClient()
      const target = await a2a.fetchCard(args.cardUrl as string)
      return a2a.send(
        target,
        compact({
          text: args.text,
          contextId: args.contextId,
          taskId: args.taskId,
          messageId: args.messageId ?? randomUUID(),
        }) as never,
      )
    }
    case 'inkbox_a2a_check': {
      const a2a = await identity.a2aClient()
      const target = await a2a.fetchCard(args.cardUrl as string)
      return args.wait ? a2a.wait(target, args.taskId as string) : a2a.getTask(target, args.taskId as string)
    }
    case 'inkbox_a2a_reply': {
      const a2a = await identity.a2aClient()
      const target = await a2a.fetchCard(args.cardUrl as string)
      return a2a.send(target, {
        taskId: args.taskId as string,
        text: args.text as string,
        messageId: (args.messageId as string | undefined) ?? randomUUID(),
      })
    }
    case 'inkbox_a2a_complete':
      return identity.a2aReply(args.taskId as string, { intent: 'complete', text: args.text as string })
    case 'inkbox_a2a_ask_caller':
      return identity.a2aReply(args.taskId as string, { intent: 'ask_caller', text: args.text as string })
    case 'inkbox_a2a_fail':
      return identity.a2aReply(args.taskId as string, { intent: 'fail', text: args.reason as string })
    case 'inkbox_list_a2a_tasks':
      return identity.a2aTasks(
        compact({ ...args, q: args.query as string | undefined, query: undefined }) as never,
      )
    case 'inkbox_list_a2a_messages':
      return identity.a2aMessages(
        compact({ ...args, q: args.query as string | undefined, query: undefined }) as never,
      )
    case 'inkbox_list_a2a_sent_tasks':
      return identity.a2aSentTasks(
        compact({ ...args, q: args.query as string | undefined, query: undefined }) as never,
      )
    case 'inkbox_get_a2a_sent_task':
      return identity.a2aSentTask(args.taskId as string)
    default:
      throw new Error(`Unknown Inkbox tool: ${name}`)
  }
}

export function registerTools(ctx: Context, runtime: InkboxRuntime): void {
  for (const entry of TOOL_CATALOG) {
    ctx.tools.register(
      defineTool({
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
        output: stringOutput,
        ...(readNames.has(entry.name) ? { isConcurrencySafe: () => true } : {}),
        async execute(rawArgs, exec) {
          const args = rawArgs as Args
          if (entry.approval !== undefined && !runtime.config.autoApproveInkboxTools)
            await approve(ctx, exec, entry.name, entry.approval(args))
          if (exec.signal.aborted) throw exec.signal.reason ?? new Error('Tool call cancelled')
          try {
            const client = await runtime.getClient()
            const identity = await runtime.getIdentity()
            return json(await execute(entry.name, args, client, identity, runtime))
          } catch (error) {
            throw presentError(error)
          }
        },
      }),
    )
  }
}
