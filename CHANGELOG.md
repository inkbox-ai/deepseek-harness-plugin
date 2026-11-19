# Changelog

## 0.2.6

- Add local delivery (`INKBOX_DELIVERY_MODE=local`): the gateway opens no tunnel, registers no webhook URL, and handles signed requests passed to it by the host. Identities without a tunnel are supported in this mode.
- Handle `inbound.received` events in local delivery. Each event is written to a local queue in the state directory before it is acknowledged, and handling resumes after a restart. `agent` handlers run one untrusted-content turn per source; `script` handlers run the command with the event on stdin (120 s limit) and pass non-empty output to the agent. A failing script or agent turn runs at most 5 times (retries after 10 s, 30 s, 2 min, 10 min); the failure is then reported with its `delivery_id`, and the report is retried for up to 24 hours. Queued work, including retry waits, counts as gateway activity. Events are deduplicated by `delivery_id`, so a replay runs again. Script output is capped at 64 KiB and stderr at a 4 KiB tail; request bodies in agent messages are capped at 64 KiB. Other modes ignore these events.
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
