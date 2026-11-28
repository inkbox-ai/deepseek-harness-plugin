---
name: inkbox-credential-use
description: Use when the user asks the agent to "log into X", "get the API key for Y", "fetch the SSH key for Z", or "give me the TOTP code for service A". Covers the Inkbox Vault credential tools. Always list first, then read one credential; never enumerate plaintext.
user-invocable: false
---

# Inkbox credential use

When an action needs a password, API key, SSH key, or TOTP code, retrieve it from the Inkbox Vault with these tools.

## Tools

- `inkbox_credentials_list`: metadata only (id, name, secretType, description) for credentials shared with this identity. Works while the Vault is locked.
- `inkbox_credentials_get_login`: plaintext login (username, password, optional URL) plus `has_totp`; the TOTP seed is never returned.
- `inkbox_credentials_get_api_key`: plaintext API key.
- `inkbox_credentials_get_ssh_key`: plaintext SSH private key and any public key, fingerprint, or passphrase.
- `inkbox_totp_code`: current TOTP code and seconds remaining for a login that has TOTP configured.

The plaintext tools ask for approval unless the profile trusts Inkbox tools.

## Prerequisites

- The Vault is initialized and the credential is shared with this identity (set up in Inkbox Console).
- The Vault unlock key is available as `INKBOX_DEEPSEEK_VAULT_KEY`:
  - **Hosted by Inkbox:** save it as a Secret named `INKBOX_DEEPSEEK_VAULT_KEY` in the identity's Env vars tab. Exporting it in a terminal does not reach a hosted agent.
  - **Self-hosted:** export it in the shell that launches the Harness (`inkbox-deepseek run`), or add it to the Harness `.env` for the managed service, then restart.

If the key is missing, a plaintext read returns "Vault is locked." Tell the user which path applies and retry after they confirm. Never ask for the key in chat or as a tool argument.

## Workflow

1. **List first.** Call `inkbox_credentials_list` (optionally with `type`) and pick the `id` by `name`. Never guess UUIDs.
2. **Confirm when stakes are high.** For production or financial accounts, check the credential's name and description with the user before reading plaintext.
3. **Read the matching type.** Login → `inkbox_credentials_get_login`; API key → `inkbox_credentials_get_api_key`; SSH key → `inkbox_credentials_get_ssh_key`. Use the fields for the requested action.
4. **TOTP.** Call `inkbox_totp_code` with the login's UUID. If fewer than about 5 seconds remain, request a new code before using it.

## Hygiene

- **Don't list-then-dump.** Read only the credential the task needs.
- **Don't paste plaintext into chat** unless the user explicitly asked to see it.
- **Don't store secrets in session memory.** Each read rechecks access and fetches the current value.

## Errors

| Error | Meaning |
|---|---|
| `Vault is locked...` | `INKBOX_DEEPSEEK_VAULT_KEY` is not configured; see Prerequisites. |
| `not shared with the configured identity` | Wrong credential, or access has not been granted in Inkbox Console. |
| `not a <type> secret` | The typed getter does not match `secretType`; re-list and use the matching tool. |
| `secretId must be a UUID` | Pass the `id` from `inkbox_credentials_list`. |

## What this skill does NOT cover

- Creating, updating, or deleting secrets.
- Granting access to secrets; that is done in Inkbox Console.
- TOTP setup, which also happens in Inkbox Console.

## When you need more — raw Inkbox docs

- **https://inkbox.ai/llms.txt** — LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.

Especially useful when checking the exact fields on `LoginPayload`, `APIKeyPayload`, `SSHKeyPayload`, or `TOTPCode` rather than guessing.
