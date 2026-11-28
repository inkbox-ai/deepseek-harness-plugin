---
name: inkbox-identity-access
description: Use when the user asks which Inkbox agent identities can see a contact or note, or asks to grant/revoke cross-identity note access. Contacts are organization-wide; note-access changes use the remote Inkbox tool catalog when it offers them.
user-invocable: false
---

# Inkbox identity access

Use this skill when explaining organization-wide contact visibility or per-identity note access.

## DeepSeek Harness tool availability

- Note-access tools are not registered natively.
- Contacts do not have per-identity access controls.
- Check the current Inkbox tool catalog (`inkbox_remote_tools` to discover and read a schema, `inkbox_remote_call` to run it) for note-access tools; if none is offered, direct the user to Inkbox Console.

## Workflow

1. Clarify whether the request is about contact visibility or note visibility.
2. For contacts, explain that every identity in the organization can see them and access cannot be granted or revoked per identity.
3. For notes, explain that grants use an explicit `identityId`. Use a remote note-access tool when the catalog offers one.
4. Otherwise summarize the requested note access change for execution in Inkbox Console.
5. If the user gives an agent handle instead of an identity UUID, explain that note access tooling may need the identity id.

## Safety

Note access changes affect what other Inkbox agent identities can see. Confirm the target identity and note before requesting a change.
