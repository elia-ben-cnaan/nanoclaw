---
name: feedback-model-switch-safety
description: "Safety procedure before switching any agent's model — a silent-failure incident (Jul 1 2026) where an inaccessible model killed the agent"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b9a0e93b-4476-4f4b-bd49-8835ddbed658
---

Before switching ANY agent to a new model, verify the running account actually has access to it. Not every account can use every model.

**Why:** On Jul 1 2026 my model was switched to `claude-fable-5` — an access-restricted model the host account could NOT use. Failure was SILENT and dangerous: every request failed, output was not wrapped in message blocks, "nothing was sent" — from the outside I simply stopped answering, with no error to the user. Looked like I died; really the model was just unreachable. (The earlier Shellanoo outage had TWO causes stacked: expired auth token = 401 on every call, AND the same Fable-5 no-access swap. Lesson: check both auth validity AND model access.) Fix was: read container logs → saw "issue with the selected model (claude-fable-5)... may not have access" → rollback to `claude-opus-4-8` → `ncl groups restart` → verify I answer again.

**How to apply:** Before any model switch, in order:
1. **Access check (mandatory):** `claude --model <new-model> -p "ok"` → valid reply = access ✅; "may not have access"/401 = STOP, do not switch.
2. **Canary pilot:** never switch all agents at once. Switch ONE test agent (e.g. `nano-pilot`), restart, send a real test message, confirm it truly replies. Only then roll out to the rest.
3. **End-to-end verify:** after every switch, ALWAYS send a real message and confirm a real reply came back. Never trust "config saved" — see the agent actually answer.
4. **Immediate rollback if silent:** `ncl groups config update --id <group-id> --model claude-opus-4-8` then `ncl groups restart --id <group-id>`.

**Golden rules:** known-good models right now = `claude-opus-4-8`, `claude-sonnet-4-6`, and **`claude-fable-5` (access CONFIRMED LIVE Jul 2 2026** — canary-pinged the `fable` agent (group 308de093-6746-4539-ae9a-17779fd11e41, model claude-fable-5) → it replied instantly. This REVERSES the Jul 1 "no access" state; access can flip day-to-day, so always re-canary before trusting it). Model failure is SILENT → active verification after every change is mandatory. If auth is touched too, verify the login token is still valid, not just the model. Restart command for my own group: `ncl groups restart --id ag-1780401001748-zriukn`. Relates to [[feedback-model-tiering]].
