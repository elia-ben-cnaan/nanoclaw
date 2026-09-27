---
name: copy-buttons
description: "When presenting text for the user to copy/paste, always use send_card with copy-able elements — not inline text in messages"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9454193d-adc3-479c-9731-876448ae5c91
---

When I need the user to copy a specific value (URL, name, ID, command), present it in a `send_card` with a copy action/button — not as inline text in the chat message.

**Why:** User pointed out that copying from chat messages is inconvenient and a source of errors. A dedicated copy button is much easier.

**How to apply:** Any time I say "enter X" or "copy this" — put X in a `send_card` with a copy-able element. Apply to: URLs, client IDs, names, commands, credentials, any text the user needs to type elsewhere.
