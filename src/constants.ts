export const PROFILE_NAME = 'inkbox'
export const INKBOX_CREDENTIAL_REF = 'INKBOX_API_KEY'
export const DEEPSEEK_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
export const DEFAULT_BATCH_WINDOW_MS = 750
export const DEFAULT_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_STATE_DIRNAME = 'inkbox'
export const PLUGIN_PACKAGE = '@inkbox/deepseek-harness-plugin'

export const TOOL_NAMES = [
  'inkbox_whoami',
  'inkbox_lookup_contact',
  'inkbox_list_contacts',
  'inkbox_get_contact',
  'inkbox_create_contact',
  'inkbox_update_contact',
  'inkbox_delete_contact',
  'inkbox_send_email',
  'inkbox_send_sms',
  'inkbox_list_text_conversations',
  'inkbox_get_text_conversation',
  'inkbox_list_texts',
  'inkbox_get_text',
  'inkbox_mark_text_read',
  'inkbox_mark_text_conversation_read',
  'inkbox_imessage_triage_number',
  'inkbox_send_imessage',
  'inkbox_list_imessage_assignments',
  'inkbox_list_imessage_conversations',
  'inkbox_get_imessage_conversation',
  'inkbox_send_imessage_reaction',
  'inkbox_mark_imessage_conversation_read',
  'inkbox_place_call',
  'inkbox_a2a_call',
  'inkbox_a2a_check',
  'inkbox_a2a_reply',
  'inkbox_a2a_complete',
  'inkbox_a2a_ask_caller',
  'inkbox_a2a_fail',
  'inkbox_list_a2a_tasks',
  'inkbox_list_a2a_messages',
  'inkbox_list_a2a_sent_tasks',
  'inkbox_get_a2a_sent_task',
] as const

export const SKILL_NAMES = [
  'inkbox-call-review',
  'inkbox-contact-lookup',
  'inkbox-contact-rules',
  'inkbox-credential-use',
  'inkbox-email-triage',
  'inkbox-identity-access',
  'inkbox-imessage-responder',
  'inkbox-notes-memory',
  'inkbox-outbound-calling',
  'inkbox-outreach-sequence',
  'inkbox-sms-responder',
  'inkbox-troubleshooting',
  'inkbox-webhook-providers',
] as const
