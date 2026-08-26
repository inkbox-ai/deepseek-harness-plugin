---
name: inkbox-notes-memory
description: Use when the user asks to save, remember, list, retrieve, update, or delete notes in Inkbox. DeepSeek Harness does not expose Inkbox note tools; explain the limitation or use host memory only if available outside this plugin.
user-invocable: false
---

# Inkbox notes memory

This DeepSeek Harness integration does not register Inkbox note tools, so do not claim you can create, list, retrieve, update, or delete Inkbox notes from this plugin.

## DeepSeek Harness tool availability

- There is no `inkbox_list_notes`, `inkbox_get_note`, `inkbox_create_note`, `inkbox_update_note`, or `inkbox_delete_note` tool in DeepSeek Harness.
- If the host provides a separate memory/notes feature, use it only when it is actually available in the current tool list.
- If the user specifically asks for Inkbox notes, explain that this DeepSeek Harness installation cannot manage them directly.

## Workflow

1. **Clarify storage target.** If the user says "remember this", ask whether host-local memory is acceptable when no memory tool is visible.
2. **Do not fake persistence.** Do not say you saved an Inkbox note unless an actual note tool completed successfully.
3. **For contact facts, use the contact guidance.** DeepSeek Harness can read, create, update, and delete visible Inkbox contacts, but contacts are not general-purpose notes.

## Access semantics

- Inkbox note reads/writes are not available through this DeepSeek Harness tool tier.
- Host workspace notes/memory, if present, are different from Inkbox notes.

## When you need more - raw Inkbox docs

If a notes field, access rule, or error behavior is not covered here, use the raw docs:

- **https://inkbox.ai/llms.txt** - LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** - the full Inkbox documentation concatenated as one markdown file.
