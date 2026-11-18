# Remote tool behavior

The plugin requires Inkbox SDK 0.7.38 or newer. Source development uses the immutable SDK revision in
`pnpm-lock.yaml`; install it with `pnpm install --frozen-lockfile`. Published installations require the
SDK release to be available first.

The supported native runtime is DeepSeek Harness 0.1.1-rc.2. Its tool schema language cannot represent
all JSON Schema constraints, so the plugin exposes two native tools: `inkbox_remote_tools` returns
complete descriptors in bounded pages, and `inkbox_remote_call` submits arguments to the selected tool.
The SDK validates the full input schema and returns the complete MCP result, including structured
content and annotations. Discovery runs before the first model step of each turn. A running turn keeps
its catalog until completion; additions, changes and removals appear on the next turn.

Interactive calls use native approval unless the user explicitly enabled automatic Inkbox tool
approval. Verified incoming messages have a separate delivery context. Cancellation and a retired
native turn prevent later submissions. Remote operation identity includes the native session, turn and
tool-call ID; equal arguments in two different calls are not merged. API credentials and identity remain
bound to the current connection. Admin-scoped and unclaimed credentials retain local setup tools;
unavailable or unknown authority does not fall back to local execution of a migrated remote alias.

| Existing capability | Behavior |
| --- | --- |
| Contact lookup, list, get, create, update, delete | Existing names delegate to canonical remote tools for claimed identities. Labelled addresses, primary flags and deletion identity are preserved. |
| Email and text sends | Existing local delivery tools remain for channel-specific arguments and media. Canonical remote tools are also discoverable. |
| Text and iMessage history, reactions, read state | Existing selectors and channel behavior remain local. |
| Calls and live audio | Existing local voice handling remains. |
| A2A tasks and messages | Existing native task callbacks and local methods remain. |
| Identity and setup | Existing credential, claim and configuration behavior remains. |
| Final reply to an incoming email or direct SMS | `inkbox_reply_current` derives the destination from the admitted source and records a durable acceptance receipt. |

The final-reply helper requires explicit final intent. Progress or unrelated sends do not suppress the
automatic final reply. Group SMS and other channels retain their existing local delivery behavior. A
pending remote send must be reconciled with its original operation; editing the text cannot turn an
uncertain send into a new send. A rejected operation that was never submitted can be replaced.

Local automatic delivery now records submission before sending. Rate-limit rejection can retry without
rerunning the model. Lost responses, interrupted submissions and older pending records without a known
submission state remain uncertain and need reconciliation before another send. A received event is not
reported completed merely because no model turn is running. The `./runtime` integration entry exposes
`Gateway.eventState(eventId)` for this distinction; `dispatchVerified` is admission, not completion.

Remote journals are stored under the configured state directory, scoped by connection and native
session or delivery route. They contain operation hashes, continuations and acceptance IDs, not message
bodies. Each journal has a bounded capacity. Retire a session journal only after that native session and
all of its uncertain operations are conclusively finished; deleting a live journal loses retry identity.

Local tests use the actual native tool runtime and synthetic HTTP responses. They cover full schema
preservation, native call identity, approval, catalog refresh, cancellation and uncertain final replies.
They do not establish live model or account availability.
