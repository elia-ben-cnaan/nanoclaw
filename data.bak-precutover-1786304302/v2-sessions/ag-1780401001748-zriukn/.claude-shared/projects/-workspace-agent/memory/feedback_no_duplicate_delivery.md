---
name: feedback_no_duplicate_delivery
description: Never repeat the same content across a mid-turn send_message and the final <message> block — it delivers twice
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a0fa14c0-1d1f-42f1-9ad1-b2b0391129fb
---

Elia flagged (Jun 24, #4732) that both Daniela and his agent Shellanoo started writing "double messages" again — screenshots showed the same numbered list posted twice in a row.

**Why:** Each `send_message` (mid-turn) and each final-response `<message>` block lands as its own separate message. If I send substantive content via send_message AND then repeat that same content in the final block, the reader sees it twice.

**How to apply:** Use mid-turn `send_message` ONLY for short acknowledgments ("on it"), never for the substantive answer. Deliver the full content exactly once — in the final `<message>` block. Never overlap content between a live update and the final message. For the pilot/agents this is the same issue as [[pilot_agent_definition]] rule 3 (one message per turn).
