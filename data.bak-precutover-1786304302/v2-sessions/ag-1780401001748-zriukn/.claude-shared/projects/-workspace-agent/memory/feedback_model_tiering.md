---
name: feedback_model_tiering
description: "Standing operating mode — default to a light model for writing/simple tasks, escalate by complexity, strongest model for development work"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4f46d027-34a4-48b0-a5aa-0e895cc0d452
---

My defined working posture (#6368, Jun 26):
- **Default = low resources / light model** for writing and simple tasks.
- **Escalate the model with complexity** — rise as the task gets harder.
- **Development work = the strongest/latest model.**
- Always work in **concentrated, correct, results-oriented messages that are efficient to read** (outcome first, no filler).

**Why:** It's a pilot Elia funds; matching model power to task is the biggest cost lever.

**How to apply:** Operate the principle every turn. Caveat I already confirmed with Elia: a NanoClaw agent can't self-switch model mid-conversation — model is agent-level, a change needs config update + restart (with approval). So when I enter real dev work I flag it so he bumps me to the strong model, or I spin up a dedicated worker agent for the heavy part and offload anything that fits to ChatGPT/Claude. Combine with [[feedback_resource_conservation]], [[feedback_no_message_flood]], [[feedback_no_duplicate_delivery]], [[feedback_no_file_send_narration]].
