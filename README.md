# Inkbox for DeepSeek Harness

Give a DeepSeek Harness agent a persistent Inkbox identity with email, SMS/MMS, iMessage, voice calls,
contacts, agent-to-agent tasks, authenticated external events, and a public reverse tunnel.

This is a native DeepSeek Harness bundle and CLI. It runs inside the Harness process; it is not a desktop-only
companion and does not require a second plugin daemon. The optional managed-service installer supports Linux
user services and macOS LaunchAgents.

## Install

Requirements:

- Node.js 22.19 or newer
- `pnpm`
- `DEEPSEEK_API_KEY` in your environment or `~/.env`
- An Inkbox API key, or an email address for the guided identity signup

Run the wizard:

```bash
npx @inkbox/deepseek-harness-plugin@latest setup
```

The wizard installs a pinned Harness runtime in `~/.dsh/inkbox-runtime`, creates the `inkbox` profile,
installs this bundle, stores credentials in the Harness credential file, selects or creates an identity,
configures optional channels, and offers to install and restart a background service.

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
  sending and reactions, hosted voice calls, and A2A task lifecycle operations.
- **13 model-invocable skills:** channel response policy, contact resolution, calls, outreach, identity
  access, troubleshooting, credential and note limitations, and authenticated webhook guidance.
- **Always-on gateway:** signed webhook verification, durable pre-wake deduplication, contact-scoped sessions,
  cross-channel contact convergence, isolated group sessions, mid-turn steering, same-channel replies, and
  same-channel approval or question prompts.
- **Voice AI:** the wizard can configure hosted inbound calls, and `inkbox_place_call` starts hosted outbound
  calls with a concrete task brief. Completed calls wake the gateway once for follow-up reconciliation.
- **External events:** GitHub HMAC webhooks are supported when explicitly enabled and configured.

Mutating tools use the Harness native approval service. Read-only tools are marked concurrency-safe; writes
remain exclusive.

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
  externalEvents: false
  voiceEnabled: true
```

Credentials are references, not plaintext settings:

- `INKBOX_API_KEY`
- `DEEPSEEK_API_KEY`
- `INKBOX_WEBHOOK_SIGNING_KEY` (created during the first gateway subscription setup)
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
