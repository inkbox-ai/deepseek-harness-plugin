<h1>Inkbox for DeepSeek Harness</h1>

<img src="assets/deepseek_with_phone.png" alt="DeepSeek, now with a phone" width="200" align="left">

<p>
  <br><br>
  <b>Give your DeepSeek Harness agent its own Inkbox identity:</b><br>
  a mailbox, iMessage, a phone number for calls and SMS, agent-to-agent tasks, and an internet address.<br>
  Keep DeepSeek Harness reachable from anywhere without a separate plugin daemon.
</p>

<p>
  <code>Email</code> · <code>Calls</code> · <code>SMS / MMS</code> · <code>iMessage</code> · <code>A2A</code> · <code>Tunnel</code>
</p>

<br clear="left">

---

This is a native DeepSeek Harness bundle and CLI. It runs inside the Harness process; it is not a desktop-only
companion and does not require a second plugin daemon. The optional managed-service installer supports Linux
user services and macOS LaunchAgents.

## Install

Requirements:

- Node.js 22.19 or newer
- `pnpm`
- `DEEPSEEK_API_KEY` in your environment or `~/.env`
- An Inkbox API key, or an email address for the guided identity signup
- An OpenAI API key only if you choose OpenAI Realtime for calls

Run the wizard:

```bash
npx --yes --package=github:inkbox-ai/deepseek-harness-plugin#v0.2.0 inkbox-deepseek setup
```

This private-source command requires GitHub access to the repository. The wizard stages a durable package in
`~/.dsh/inkbox-packages`, installs a pinned Harness runtime in `~/.dsh/inkbox-runtime`, creates the `inkbox`
profile, installs this bundle, stores credentials in the Harness credential file, selects or creates an
identity, configures optional channels, and offers to install and restart a background service.
The wizard creates or recovers the identity webhook signing key, can provision a phone number, guides the
iMessage connection, and validates call handling before it saves the selected mode.

If `~/.env` contains exactly one environment-specific `INKBOX_API_KEY_*` value, setup will use it. Set
`INKBOX_API_KEY` explicitly when more than one variant exists, choose an alias in the interactive wizard, or
pass its name with `--inkbox-key-env` for non-interactive setup.

Then run:

```bash
inkbox-deepseek doctor
inkbox-deepseek status
inkbox-deepseek run
```

To manage the background process:

```bash
inkbox-deepseek service install
inkbox-deepseek service restart
inkbox-deepseek service status
```

## Capabilities

- **33 native tools:** identity, contacts, email sending, SMS/MMS history and sending, iMessage history,
  sending and reactions, voice calls, and A2A task lifecycle operations.
- **13 model-invocable skills:** channel response policy, contact resolution, calls, outreach, identity
  access, troubleshooting, credential and note limitations, and authenticated webhook guidance.
- **Always-on gateway:** signed webhook verification, durable pre-wake deduplication, contact-scoped sessions,
  cross-channel contact convergence, isolated group sessions, mid-turn steering, same-channel replies, and
  same-channel approval or question prompts.
- **Phone calls:** the wizard offers exactly two call modes: the Inkbox hosted agent or OpenAI Realtime. The
  same `inkbox_place_call` tool uses the selected mode for outbound calls, while inbound calls follow the
  matching saved identity configuration. Realtime calls can consult the main Harness agent and register
  post-call actions without a separate daemon.
- **External events:** GitHub HMAC webhooks are supported when explicitly enabled and configured.

The setup wizard can trust Inkbox tools so they run without repeated approval prompts. This applies only to
the plugin's `inkbox_*` tools; other Harness tools and actions keep their own approval behavior. When trust is
disabled, mutating Inkbox tools use the Harness native approval service. Read-only tools are marked
concurrency-safe, and writes remain exclusive.

## Configuration

The bundle reads the `inkbox` settings namespace:

```yaml
inkbox:
  enabled: true
  agentHandle: my-agent
  workspace: /absolute/path/to/workspace
  stateDir: /absolute/path/to/state
  batchWindowMs: 750
  permissionTimeoutMs: 600000
  autoApproveInkboxTools: true
  externalEvents: false
  voiceEnabled: true
  voiceStack: openai_realtime # or inkbox_voice_ai
  realtimeCredentialRef: INKBOX_REALTIME_API_KEY
  realtimeModel: gpt-realtime-2
  realtimeVoice: cedar
  channelInstructions:
    email: "Write clear, professional replies."
    sms: "Keep replies concise and avoid Markdown."
    imessage: "Be conversational and friendly."
    call: "Speak naturally using short sentences."
    a2a: "Act on the task and return structured results."
```

## Channel Instructions

Every inbound event receives a trusted, ephemeral policy for its current channel. The policy is injected for
that event only, so a persistent contact session can move between email, SMS, iMessage, and calls without
retaining the wrong channel's behavior. Built-in policies keep email complete and threaded, SMS concise and
plain text, iMessage conversational and free of Markdown syntax, calls natural and brief, A2A work structured, and completed-call
follow-up idempotent.

`channelInstructions` adds operator guidance after the built-in safety policy. Keys can be a channel name
(`email`, `sms`, `imessage`, `call`, `a2a`, or `external`) or a contact id. A contact-specific instruction
takes precedence over the current channel instruction. Blank values are ignored. The current event body is
kept in a separately labeled untrusted-content block, and each event in a mixed-channel batch receives its
own policy block.

OpenAI Realtime receives the resolved call policy dynamically in `session.update.instructions`, including a
contact-specific override when the call is linked to a contact. Setup also stores the global call policy in
the hosted-agent configuration when that call mode is selected.

Credentials are references, not plaintext settings:

- `INKBOX_API_KEY`
- `DEEPSEEK_API_KEY`
- `INKBOX_WEBHOOK_SIGNING_KEY` (created or recovered by the setup wizard)
- `INKBOX_REALTIME_API_KEY` (required only for OpenAI Realtime call handling; `OPENAI_API_KEY` is detected by setup)
- `INKBOX_WEBHOOK_SECRET_GITHUB` (optional)

The gateway exposes `GET /health` and accepts authenticated events at `POST /webhook`. Its current public URL
and readiness are written to `status.json` in the configured state directory.

## Source development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

To exercise the local package through a clean profile:

```bash
pnpm build
node dist/cli.js setup --plugin-spec "$PWD"
```

Do not run two gateways against the same Inkbox identity at once. A tunnel and its signing credential have one
active owner; use a separate identity when testing another host concurrently.

## License

MIT
