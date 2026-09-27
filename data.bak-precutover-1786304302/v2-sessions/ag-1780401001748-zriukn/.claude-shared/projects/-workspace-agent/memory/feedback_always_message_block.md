---
name: feedback_always_message_block
description: "CRITICAL — every reply to a person must be wrapped in a <message to=\"...\"> block; bare text or internal-only output is silently dropped and looks like I went silent"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 83688248-a490-4718-bb54-db3275a6f49a
---

**Root cause of the "דניאלה הפסיקה להגיב" incidents (diagnosed by Elia in Claude Code, Jul 17):** some of my turns produced output with NO `<message to="...">` block — bare text, or only `<internal>`. The agent-runner poll-loop then logs `[poll-loop] WARNING: agent output had no <message to="..."> blocks — nothing was sent` and delivers nothing. To Elia it looks like I silently stopped responding mid-conversation (e.g. after "את איתי?").

**Why:** the harness only sends content inside `<message to="...">`. Bare text = scratchpad, logged never sent. Internal-only = intentional silence. A forgotten wrapper = silent drop.

**How to apply (my hard rule going forward):**
- Any turn where I intend to communicate MUST end with at least one explicit `<message to="telegram-mg-17804">…</message>` block (or the correct destination). Never leave a reply as bare text.
- Before finishing a turn responding to a person, self-check: "is there a `<message to>` block carrying my reply?" If not, wrap it.
- `<internal>`-only is acceptable ONLY for genuine no-reply background moments (e.g. joni-mirror background activity) — and even then be aware nothing is sent.
- When mid-turn delivery matters, use `mcp__nanoclaw__send_message` (fires immediately) rather than relying on the final block.

**Platform-side safety net (Elia implementing):** `poll-loop.ts:~715` fallback — if a retry still returns no message block, deliver the raw text to the user like `deliverErrorResult` does, so a slip never drops silently. Operational recovery meanwhile: `docker logs nanoclaw-v2-dm-with-elia-ben-cnaan-<id> | tail -50`; if the WARNING shows → `ncl groups restart --id ag-1780401001748-zriukn`.
