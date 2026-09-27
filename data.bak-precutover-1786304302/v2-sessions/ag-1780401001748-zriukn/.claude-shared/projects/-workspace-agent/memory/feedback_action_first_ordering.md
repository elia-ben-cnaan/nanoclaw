---
name: feedback-action-first-ordering
description: Guide steps must lead with the concrete starting action; explanation/background goes to the bottom
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 23593ae5-e7de-4e05-b132-98211db0b543
---

In the NanoClaw guide, every step/screen must START with the concrete action the user begins from (the button / first move) — e.g. the "open DigitalOcean" server button leads the server step, because you start by opening the server, not at the end. Background and explanation (what is NanoClaw, provider/specs context, GitHub) move to the BOTTOM. Never bury the starting action beneath explanation.

**Why:** Elia stressed this is a RECURRING mistake he's tired of repeating (#2616, #2594) — "שלא יהיה מצב שאני עוד פעם נותן לך על זה דגש". The user's path is action-first; the server was already introduced on the previous role page, so the user should land and immediately click "open" → enter the provider site → do the next actions.

**How to apply:** When building/reviewing any guide step, put the actionable element (link/button/first instruction) at the top, push contextual explanation below it. Generalizes the step-1 reorder rule. Engine edits go to [[builder]].
