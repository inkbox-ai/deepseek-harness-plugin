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

This is a native DeepSeek Harness bundle and CLI. It runs inside the Harness process rather than using a
second plugin daemon. Foreground mode works anywhere DeepSeek Harness runs; managed background services are
supported on Linux and macOS.

## Prerequisites

- **An installed DeepSeek Harness `0.1.1-rc.2`.** The `dsh` command must be on `PATH`. Install the currently
  supported Harness version with `npm install --global @deepseek-ai/dsh@0.1.1-rc.2`.
- **A configured DeepSeek Harness.** `DEEPSEEK_API_KEY` can already be stored in the Harness home, inherited
  from the environment, or set in `~/.env`.
- **Node.js 22.19 or newer and `pnpm`.** The existing Harness uses `pnpm` to install the Inkbox bundle into
  its dedicated `inkbox` profile.
- **An Inkbox identity.** Nothing needs to be created in advance: the wizard can create one through guided
  email verification, or it can use an existing Inkbox API key.
- **Repository access.** The one-command installer downloads the plugin from GitHub.
- **Optional OpenAI API key.** This is needed only if you choose OpenAI Realtime instead of the hosted call
  agent.

## Quick Start

### Add Inkbox to an Existing DeepSeek Harness

Confirm that the supported Harness is installed and available:

```bash
dsh --version
```

Then run the Inkbox installer and setup wizard:

```bash
npx --yes --package=github:inkbox-ai/deepseek-harness-plugin#main inkbox-deepseek setup
```

The wizard installs Inkbox into a dedicated `inkbox` profile under the existing Harness home. It does not
replace the running Harness or install another copy.

### From Scratch

Install Node.js 22.19 or newer, then install `pnpm` and the supported DeepSeek Harness:

```bash
npm install --global pnpm @deepseek-ai/dsh@0.1.1-rc.2
```

Create the Harness environment file and add your DeepSeek API key:

```bash
mkdir -p ~/.dsh
read -rsp 'DeepSeek API key: ' DEEPSEEK_API_KEY
printf '\n'
export DEEPSEEK_API_KEY
(umask 077 && printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY" > ~/.dsh/.env)
```

Verify the Harness installation and configuration:

```bash
dsh --version
dsh web
```

After the Web UI opens successfully, stop it with `Ctrl+C`, then run the Inkbox wizard in the same terminal:

```bash
npx --yes --package=github:inkbox-ai/deepseek-harness-plugin#main inkbox-deepseek setup
```

The wizard creates the `inkbox` Harness profile, installs the persistent `inkbox-deepseek` launcher, and
walks through identity and channel setup. It can also install and launch a background service.

### Verify the Inkbox Agent

When the wizard finishes, check the agent:

```bash
inkbox-deepseek doctor
inkbox-deepseek status
```

If you did not start the background service during setup, run the gateway in the foreground:

```bash
inkbox-deepseek run
```

Keep the foreground process running. The gateway opens the agent tunnel, reconciles channel subscriptions,
and routes inbound email, SMS, iMessage, calls, and A2A events into persistent DeepSeek Harness sessions.

## Setup Wizard

`inkbox-deepseek setup` walks through the complete Inkbox configuration:

1. Verifies the installed DeepSeek Harness version and configuration, then discovers any existing `inkbox`
   profile.
2. Creates a fresh Inkbox identity through email verification, or securely accepts an existing API key.
3. Selects or creates the identity used by this Harness profile, attaches the bundled contact avatar, and
   explains the server-side reachability rules that control who can contact the agent.
4. Installs the Inkbox bundle into the existing DeepSeek Harness and creates the `inkbox` profile.
5. Offers iMessage with RCS/SMS fallback and voice calls, displays a scannable connection QR code, and can
   wait for the first iMessage before continuing.
6. Optionally provisions a dedicated number for SMS and voice. New numbers display a scannable `START` QR
   code and can wait for SMS opt-in.
7. Configures either the Inkbox hosted call agent or the OpenAI Realtime API. TTS/STT mode is not offered.
8. Reuses a supplied webhook signing key or creates a new one with explicit rotation confirmation.
9. Saves the identity, credentials, channel choices, trusted Inkbox-tool behavior, and workspace in the
   `inkbox` Harness profile.
10. Offers to install or restart the managed gateway and verifies that the process and tunnel are ready.

Rerunning setup discovers the existing profile and asks before reconfiguring it. Existing avatars and channel
resources are preserved unless a setup choice explicitly changes them.

Environment-specific `INKBOX_API_KEY_*` credentials are never listed in the interactive wizard. Automated
setup can select one explicitly with `--inkbox-key-env`; otherwise non-interactive setup uses `INKBOX_API_KEY`.

## Running the Gateway

The setup wizard can install a systemd user service on Linux or a LaunchAgent on macOS. Manage it with:

```bash
inkbox-deepseek service install
inkbox-deepseek service start
inkbox-deepseek service status
inkbox-deepseek service restart
inkbox-deepseek service stop
inkbox-deepseek service uninstall
```

For foreground operation or troubleshooting:

```bash
inkbox-deepseek run
```

Do not run foreground and managed gateways for the same profile at the same time. One Inkbox tunnel has one
active gateway owner.

## CLI

| Command | Purpose |
|---|---|
| `inkbox-deepseek setup` | Install or reconfigure the runtime, identity, channels, credentials, and service. |
| `inkbox-deepseek doctor` | Check the profile, credentials, identity, channels, bundle, and service. |
| `inkbox-deepseek status` | Show gateway, process, identity, tunnel, and public-URL readiness. |
| `inkbox-deepseek status --json` | Print machine-readable readiness information. |
| `inkbox-deepseek run` | Run the `inkbox` Harness profile in the foreground. |
| `inkbox-deepseek service <action>` | Install, start, stop, restart, inspect, or uninstall the managed service. |
| `inkbox-deepseek profile` | Print the selected Harness profile name. |

## Smoke Test

Verify the installation and live gateway:

```bash
inkbox-deepseek doctor
inkbox-deepseek status
```

`doctor` should pass every required check. `status` should report the gateway as ready, the tunnel as
connected, and the process as running. Then send an email or iMessage to the identity printed by setup; if a
dedicated number was provisioned and opted in, SMS works too. The agent should reply in the originating
channel.

If the gateway is not ready, stop any duplicate foreground process and inspect it interactively:

```bash
inkbox-deepseek service stop
inkbox-deepseek run
```

## Update or Reconfigure

Rerun the installed wizard at any time:

```bash
inkbox-deepseek setup
```

To reinstall the current GitHub package and rerun setup in one command:

```bash
npx --yes --package=github:inkbox-ai/deepseek-harness-plugin#main inkbox-deepseek setup
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
  post-call actions without a separate daemon. The Realtime model also receives `hang_up_call`, which follows
  a spoken-goodbye grace period, cancels when the caller barges in, and drains pending tool responses before
  ending the call.
- **External events:** GitHub HMAC webhooks are supported when explicitly enabled and configured.

The setup wizard trusts Inkbox tools so they run without repeated approval prompts. This applies only to the
plugin's `inkbox_*` tools; other Harness tools and actions keep their own approval behavior. Automated setup
can explicitly keep per-action prompts with `--ask-inkbox-tool-approvals`.

## Config Reference

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

## Development Commands

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

## Architecture Notes

- The plugin is a native DeepSeek Harness bundle loaded by the dedicated `inkbox` profile.
- The CLI stages a durable plugin package under `~/.dsh/inkbox-packages` and installs it with the existing
  `dsh` executable.
- The gateway verifies signed webhooks before dispatch, stores durable delivery and session state, and exposes
  `GET /health` plus authenticated `POST /webhook` handling through the Inkbox tunnel.
- Current public URL and readiness state are written to `status.json` in the configured state directory.

## License

MIT
