---
name: no-tables-telegram
description: "Telegram doesn't render markdown tables — use simple numbered lists or bold text instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9454193d-adc3-479c-9731-876448ae5c91
---

Never use pipe-formatted markdown tables in Telegram messages. They render as raw plain text with | characters and look like a mess. 

Instead use:
- Numbered lists for comparisons
- Bold headers with a line per item
- Simple bullet points

**Why:** User pointed out the table format looked bad and asked why I used it instead of a cleaner format.

**How to apply:** Any time I'm in a Telegram conversation (which is always in this setup), avoid markdown tables entirely. Reformat as lists.
