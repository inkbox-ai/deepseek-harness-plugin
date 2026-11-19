# Changelog

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
