---
name: inkbox-webhook-providers
description: Use when configuring authenticated external events for the DeepSeek Harness Inkbox gateway or explaining how inbound webhook authenticity is decided.
user-invocable: false
---

# Authenticated external webhooks

The gateway authenticates raw request bytes before it parses or routes an event. Never infer authenticity
from a body field such as `event_type` or `provider`.

## Supported sources

- Inkbox channel events use the identity's webhook signing key. The gateway manages these subscriptions
  automatically.
- GitHub events use `X-Hub-Signature-256`, `X-GitHub-Delivery`, and `X-GitHub-Event`.
- Unknown or unsigned sources are not passed through to an agent.

External providers are disabled by default. To enable GitHub events:

1. Set `inkbox.externalEvents: true` in the selected DeepSeek Harness profile settings.
2. Put `INKBOX_WEBHOOK_SECRET_GITHUB` in `~/.env`, then rerun `inkbox-deepseek setup`, or store the same
   credential reference directly in the profile's credential store.
3. Configure the GitHub webhook to send JSON to the tunnel URL plus `/webhook` using that same secret.
4. Use the public URL in the gateway status file under the configured Inkbox state directory.

## Verification behavior

1. A provider is recognized by its signature header.
2. The HMAC is calculated over the exact request body bytes.
3. A missing secret fails closed with service unavailable; a bad signature is rejected.
4. The delivery identifier becomes the durable event identifier, so retries are deduplicated before an
   agent wakes.
5. A verified external event runs without an automatic email, SMS, or iMessage reply target. The agent may
   use an outbound tool only when the event and configured permissions justify it.

## Adding another provider to the plugin

Implement recognition, raw-body verification, and normalization in `src/webhook-providers.ts`. Keep these
properties:

- Use constant-time comparison for shared-secret signatures.
- Require a stable delivery identifier for retry deduplication.
- Keep secrets in the Harness credential service, never plugin settings or logs.
- Normalize only after verification.
- Add valid-signature, invalid-signature, missing-secret, malformed-envelope, and replay tests.

Do not enable unsigned pass-through as a shortcut. If a provider uses a timestamped signature, validate its
replay window in addition to its signature.
