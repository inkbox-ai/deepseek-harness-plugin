# Changelog

## 0.2.6

- Add local delivery (`INKBOX_DELIVERY_MODE=local`): the gateway opens no tunnel, registers no webhook URL, and handles signed requests passed to it by the host. Identities without a tunnel are supported in this mode.
- Handle `inbound.received` events in local delivery. Each event is written to a local queue in the state directory before it is acknowledged, and handling resumes after a restart. `agent` handlers run one untrusted-content turn per source; `script` handlers run the command with the event on stdin (120 s limit) and pass non-empty output to the agent. A failing script runs at most 5 times (retries after 10 s, 30 s, 2 min, 10 min). An agent turn runs at most once: a failed or interrupted turn is reported, never repeated, and a failed turn on script output does not run the script again. A script run counts toward the limit before it starts, so a restart never adds a sixth run. Failures are reported with the `delivery_id` and at most 2,000 characters of error text; the report is retried with capped backoff while the gateway runs and on every start until a 2xx, a 409 (stale delivery) or any other 4xx except 408 and 429. Queued events, running scripts and turns, and script retry waits count as gateway activity; pending failure reports do not. Events are deduplicated by `delivery_id`, so a replay runs again. Script output is capped at 64 KiB and stderr at a 4 KiB tail; request bodies in agent messages are capped at 64 KiB, and a base64 body that decodes to UTF-8 is shown as text. A duplicate delivery is acknowledged only after the first copy is stored. Agent turns for a source share one session keyed by the source ID, so renaming a source keeps its history. At most 100 events or 64 MiB of request bodies wait in the queue; beyond that a new delivery is answered with 503 and not acknowledged, so it is retried. A host that acknowledges deliveries itself checks `Gateway.inboundAdmits()` first and sets `externalAdmission`, so a delivery it already acknowledged is always queued. At most 4 scripts run at once. A turn that exceeds 30 minutes is cancelled before its failure is reported. A queued event that cannot be read at startup stays on disk and is loaded again every 30 s. Other modes ignore these events.
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
