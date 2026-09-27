---
name: feedback_bare_clickable_links
description: "Always paste links as a bare URL on its own line; never glue \"ב-\" or markdown to them or they stop being clickable"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9539cd90-0d50-404f-847a-2716aa5d1b61
---

When sending Elia a link, put the **bare URL on its own line** — nothing attached. Never prefix it with "ב-" (e.g. "ב-payme-partners.vercel.app"), never wrap it in markdown `[text](url)` or bold. Any character glued to the URL makes it non-clickable in Telegram.

**Why:** Telegram only auto-links a clean URL. A leading "ב-" or markdown wrapper breaks the click target — the link renders as dead text.

**How to apply:** Write the sentence, then drop the URL alone on the next line:
```
עלה חי ומאומת:
payme-partners.vercel.app
```

Elia has flagged this multiple times — it is a hard standing rule. Related: [[feedback_copypaste_checkbox]].
