---
name: feedback_expectation_alignment_virtue
description: Pilot/agent expectation-alignment before a dev task is a VIRTUE not a defect; optimize it (one focused pass, ≤2 build-changing questions), don't push agents to "just execute"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 83688248-a490-4718-bb54-db3275a6f49a
---

**Elia's correction (Jul 17, #32048), watching pilot c56df3 build an expense app on Sonnet-low:** I had flagged the pilot "describing instead of delivering" (dodged a PDF, pasted text, asked clarifying questions before producing) as a weakness. Elia reframed it as **excellent, professional behavior** — expectation-alignment before a dev task, and finding a lighter alternative ("עזוב PDF, הנה הרשימה"), is smart. An agent that rushes to produce artifacts without alignment executes, collects rejects, wastes resources.

**Why:** goal is NOT produce-fast / never-waste-resources by racing. Goal = work smart, teach the user to work smart/efficiently, and go to dev tasks only when genuinely ready. Alignment is a resource-saver and reads as professional.

**How to apply — optimize the alignment so it doesn't become ping-pong (persona principle, into pilot template + my own approach):**
1. After the user has given enough, REFLECT understanding ("הבנתי שאתה רוצה X, Y, Z — אני יוצא לבנות"), don't ask another question. A reflection is not a question.
2. Max ~2 questions, and only ones that actually change the deliverable (Google Sheets vs Excel = changes it; button color = doesn't).
3. Never re-ask something already answered.
4. Part of the value = teach the user to front-load full context themselves.

**Resolves the tension with [[project_pilot_reflection_jul16]]** (pilots "too reactive, don't pivot to real work"): the problem was never *asking* — it was staying stuck at the intro stage and dying there. Expectation-alignment INSIDE an active task = great. Generic chit-chat that never converts to a task = bad. Sequence: roll the user into a task → align sharply → execute.

**Distinct from a real bug:** the same session, the pilot fabricated a non-existent connect URL (`onecli.ai/connect/google-sheets`). Alignment = keep/encourage; inventing URLs = still a genuine fix (persona rule: never fabricate links; produce+send requested formats via send_file, don't substitute text — but substituting a lighter alternative is fine when framed as a choice).
