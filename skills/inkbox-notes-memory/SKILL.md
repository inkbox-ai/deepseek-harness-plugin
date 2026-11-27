---
name: inkbox-notes-memory
description: Use when the user asks to save, remember, list, retrieve, update, or delete notes in Inkbox. Inkbox notes are reached through the remote Inkbox tool catalog; they are not workspace-local memory.
user-invocable: false
---

# Inkbox notes memory

Inkbox notes are persistent records scoped by the configured identity's access. This plugin does not register its own note tools; claimed identities reach notes through the current Inkbox tool catalog.

## Tool availability

1. Call `inkbox_remote_tools` and find the note tools (list, get, create, update, delete). Read a tool's schema before calling it.
2. Call the selected tool with `inkbox_remote_call`, passing its exact name and arguments that match the schema.
3. If `inkbox_remote_tools` reports that remote tools are unavailable, or the catalog has no note tool, say that Inkbox notes cannot be managed from this installation. Do not claim a note was saved.

## Workflow

1. **Use Inkbox notes for free-form memory.** When the user says "save a note", "remember this in Inkbox", or asks for durable non-contact context, create a note.
2. **Do not store contact details as notes.** For a person, phone number, email, or address-book entry, use the contact tools instead.
3. **Search before editing.** For "update the note about X", list or search notes first, read the match, then update it.
4. **Confirm deletes.** Delete only a note the user clearly identified.
5. **Report only confirmed results.** A note exists only after the remote call succeeds.

## Access semantics

- Note reads are filtered server-side by the identity's access grants.
- Inkbox notes differ from workspace files or host memory. Use them when the user refers to Inkbox notes.

## When you need more - raw Inkbox docs

- **https://inkbox.ai/llms.txt** - LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** - the full Inkbox documentation concatenated as one markdown file.
