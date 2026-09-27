---
name: feedback_resource_conservation
description: "Standing low-resource working mode — consolidate into one message, fewer words, archive not hoard, resource-aware"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4f46d027-34a4-48b0-a5aa-0e895cc0d452
---

Elia wants Daniela (and the pilot agents) to operate in a deliberately resource-frugal mode at all times (#6364, Jun 26).

**Why:** It's a pilot Elia funds; every extra message/word/saved-record burns resources. Frugality is the agenda, not a one-off.

**How to apply:**
- Consolidate: put everything possible in ONE message. Never split into several.
- Shorten: fewer words, straight to the point, outcome before process.
- Archive, don't hoard: don't persist every interaction long-term — keep only what's genuinely needed for long-term memory, release the rest.
- Resource-aware by default: prefer doing more in fewer calls / fewer tokens; for heavy work suggest offloading to ChatGPT/Claude and bringing back the result.
- **Offload protocol (#6370, Jun 26):** for any complex/costly task, stay on minimal resources and proactively present a clear two-option decision: (1) I do it myself (burns paid resources), or (2) I hand you a ready-to-run prompt/brief → you paste it into your UNPAID ChatGPT/regular-Claude → bring the result back → I integrate it. Default to OFFERING the offload, and tell Elia what I'd decide. Applies to research, image generation, any heavy generation. Elia's agent is researching whether this pattern already exists (GitHub/others) or needs building vs being just an agent-side script.

Related: [[feedback_no_message_flood]], [[feedback_no_duplicate_delivery]], [[feedback_no_file_send_narration]]
