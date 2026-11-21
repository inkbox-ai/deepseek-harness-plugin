# Changelog

## 0.2.7

- Add Slack messaging, off by default. Setup enables it and connects a workspace, saving `slackEnabled` (`--enable-slack`; `--skip-slack` writes nothing, so an absent setting stays absent). Without a profile setting, `INKBOX_SLACK_ENABLED` enables it. Doctor checks the effective setting and a connected workspace, and status reports the Slack connection.
- Route incoming Slack DMs, group DMs, mentions, thread replies and messages in an engaged thread to the agent. A plain DM joins the sender's contact session; other messages keep one session per Slack conversation and thread. Unaddressed channel traffic does not start a session. Redeliveries are deduplicated by the Slack message's `data.message_id`, falling back to the event ID.
- Send the agent's reply to the source Slack conversation and thread. The connection is checked before a reply is marked submitted: a temporary read failure retries, and a changed or removed connection refuses the reply without sending it. A send whose outcome is not confirmed is kept for attention and never repeated. While Slack is disabled, saved Slack replies are held unsent.
- Each Slack message runs as its own turn, in order. Nothing, from any channel, is merged into a running Slack turn; a message for the same contact on another channel waits for its own turn. Turns started on other channels behave as before.
- Subscribe to `slack.session_stopped`. A native stop cancels the stopping person's running turn (before its prompt is submitted when possible), queued messages and pending prompt in that thread; a reply already being delivered is not retracted. The stop and the turns it targets are recorded first, so a redelivered stop never cancels a later turn, and the stop event itself is recorded as completed. Messages sent after a stop run as a new turn.
- A prompt from a Slack turn goes to that turn's Slack conversation, and only the person whose message started the turn can answer it; in Slack, other participants' messages run as separate turns. On other channels prompts and answers are handled as ordinary messages, as before.
- Add `inkbox_slack_list_connections`, `inkbox_slack_list_conversations`, `inkbox_slack_list_messages`, `inkbox_slack_search`, `inkbox_slack_send_message` and `inkbox_slack_get_action`, registered only when Slack is enabled. Arguments are validated before any approval prompt or API call.
- Wait for Slack voice-note transcripts the same way as MMS, iMessage and WhatsApp audio, keyed by the received event's `data.message_id`; the Slack subscription carries `message.transcription_finished`. A temporary connection read failure (timeout, connection error, 408, 429 or 5xx) leaves the message unadmitted and retries it after 5 seconds; other failures are final.

## 0.2.6

- Add local delivery (`INKBOX_DELIVERY_MODE=local`): the gateway opens no tunnel, registers no webhook URL, and handles signed requests passed to it by the host. Identities without a tunnel are supported in this mode.
- Handle `inbound.received` events in local delivery. Each event is written to a local queue in the state directory before it is acknowledged, and handling resumes after a restart. `agent` handlers run one untrusted-content turn per source; `script` handlers run the command in the home directory with the event on stdin (120 s limit) and pass non-empty output to the agent. A failing script runs at most 5 times (retries after 10 s, 30 s, 2 min, 10 min). An agent turn runs at most once: a failed or interrupted turn is reported, never repeated, and a failed turn on script output does not run the script again. A script run counts toward the limit before it starts, so a restart never adds a sixth run. Failures are reported with the `delivery_id` and at most 2,000 characters of error text; the report is retried with capped backoff while the gateway runs and on every start until a 2xx, a 409 (stale delivery) or any other 4xx except 408 and 429. Queued events, running scripts and turns, and script retry waits count as gateway activity; pending failure reports do not. Events are deduplicated by `delivery_id`, so a replay runs again. Script output is capped at 64 KiB and stderr at a 4 KiB tail; request bodies in agent messages are capped at 64 KiB, and a base64 body that decodes to UTF-8 is shown as text. A duplicate delivery is acknowledged only after the first copy is stored. Agent turns for a source share one session keyed by the source ID, so renaming a source keeps its history. At most 100 events or 64 MiB (UTF-8) of request bodies and script output wait in the queue; beyond that a new delivery is answered with 503 and not acknowledged, so it is retried. A host that acknowledges deliveries itself checks `Gateway.inboundAdmits()` first and sets `externalAdmission`, so a delivery it already acknowledged is always queued. At most 4 scripts run at once. A turn that exceeds 30 minutes is cancelled before its failure is reported. Shutdown kills running scripts and starts no new agent turn; an interrupted script run counts toward its 5 runs. A queued event that cannot be read at startup stays on disk and is loaded again every 30 s. A malformed event is answered with 400 and not acknowledged. Other modes ignore these events.
- Require `@inkbox/sdk` 0.7.41 or later.

## 0.2.5

- Deliver incoming voice-note transcripts with a bounded wait, one message read on timeout, and original-attachment fallback.
- Register completion notifications and distinguish generated voice-note text from typed permissions.
- Route incoming WhatsApp messages and replies in their original conversation.

## 0.2.4

### Changed
- Require Inkbox SDK 0.7.39 for durable messaging and remote tool handling.
- Count pending reply deliveries separately from retained uncertain outcomes.
- Report the current package version in the CLI.

## 0.2.3

- Make managed diagnostics use a recent runtime health report instead of terminal signing-key or ordinary webhook settings. Keep standalone checks and report unavailable runtime evidence.

## 0.2.2

- Accept empty MCP continuation input requests through the pinned SDK revision.

- Keep contact and terminal-reply MCP arguments within the advertised schema while retaining durable operation identity and retry receipts.
