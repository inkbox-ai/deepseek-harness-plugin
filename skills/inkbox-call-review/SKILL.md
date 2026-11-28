---
name: inkbox-call-review
description: Use when the user asks about Inkbox calls, call transcripts, missed calls, or follow-up work. DeepSeek Harness uses current live/post-call context; historical call reads come from the remote Inkbox tool catalog.
user-invocable: false
---

# Inkbox call review

Use this skill when the user asks about Inkbox phone calls, transcripts, or post-call summaries.

## DeepSeek Harness tool availability

- DeepSeek Harness exposes `inkbox_place_call` for outbound calls.
- Hosted-agent and OpenAI Realtime calls provide transcript and post-call context to DeepSeek Harness during
  call wrap-up.
- Historical call-read tools are not registered natively; claimed identities reach them through the current Inkbox tool catalog (`inkbox_remote_tools` to discover and read a schema, `inkbox_remote_call` to run it).

## Workflow

1. **Current call wrap-up.** If the current call just ended and transcript,
   outcome, reason, or open action context is present in the turn, use that
   supplied context. Reconcile actions against the transcript before executing
   them, and do not duplicate completed, canceled, or superseded work. Do not
   claim to have fetched unrelated historical call data. For a callback to the
   remote party, use the remote phone number supplied in the current call
   context. It is authoritative for that call; contact memories must not
   replace it.
2. **Past call requests.** For old calls, missed calls, or transcripts, use the matching remote catalog tool. If remote tools are unavailable or the catalog has no matching tool, say so and point to Inkbox Console.
3. **Prepare follow-ups from supplied context.** If the user gives the transcript or call summary in the conversation, use that text and the available Inkbox send tools for follow-up.
4. **Complete SMS commitments with the SMS tool.** For a still-needed SMS
   requested during the call, use `inkbox_send_sms` with `to` equal to the exact
   authoritative remote phone number from the current-call context and `text`
   equal to the requested message. Do not use `conversationId` for this
   post-call send. Require a tool result with `ok: true`; plain text does not
   complete the commitment. If the first call has a recoverable argument or
   format error, correct it once and retry once. Do not duplicate a well-formed
   send. If the first error is nonrecoverable or the corrected call also fails,
   do not call again; use `[SILENT]`. Do not use `[SILENT]` while a safe SMS
   commitment remains unattempted.
5. **Avoid exact-quote claims.** Speech-to-text can be imperfect; hedge unless the user supplies exact transcript text.

## Caveats

- Without remote tools, historical call review is not available here. Use Inkbox Console for older call records.
- Contact-rule-blocked calls may be rejected before DeepSeek Harness sees an event.
