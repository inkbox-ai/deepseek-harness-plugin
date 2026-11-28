---
name: inkbox-contact-rules
description: Use when the user wants to block, allow, delete, or list Inkbox contact-rule filters for the agent's mailbox or phone number. Use the remote Inkbox tool catalog for any contact-rule tools it offers; otherwise guide the user to Inkbox Console.
user-invocable: false
---

# Inkbox contact rules

Use this skill when discussing who can reach the agent's Inkbox mailbox or phone number.

## DeepSeek Harness tool availability

- DeepSeek Harness relies on Inkbox server-side mailbox and phone contact rules for admission.
- Contact-rule tools are not registered natively. Claimed identities can use any contact-rule tools in the current Inkbox tool catalog (`inkbox_remote_tools` to discover and read a schema, `inkbox_remote_call` to run it).
- If the catalog has no tool for the requested change, tell the user it cannot be made from here and direct them to Inkbox Console.
- If the user provides a specific rule they want, summarize the exact setting they should create in Console.

## Workflow

1. Identify whether the request is for mailbox rules, phone/SMS/call rules, or both.
2. For mailbox rules, explain the intended settings:
   - `matchType: "exact_email"` for one sender address.
   - `matchType: "domain"` for a whole sender domain.
   - `action: "block"` to reject matching mail.
   - `action: "allow"` to permit matching mail when whitelist mode is active.
3. For phone rules, explain the intended settings:
   - `matchType: "exact_number"` for E.164 numbers.
   - Rules apply to SMS and voice calls for that phone number.
4. Explain that blocked inbound messages/calls may be rejected before the agent sees an event.

## Safety

Do not switch a channel into whitelist-only behavior unless a tool explicitly supports filter-mode changes and the user clearly requests that behavior. Whitelist mode blocks everyone who is not explicitly allowed.
