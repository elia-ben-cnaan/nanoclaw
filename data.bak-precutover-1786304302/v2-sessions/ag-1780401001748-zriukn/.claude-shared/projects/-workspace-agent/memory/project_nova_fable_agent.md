---
name: project-nova-fable-agent
description: nova = my own isolated companion agent running on the new claude-fable-5 model (created Jul 2 2026)
metadata: 
  node_type: memory
  type: project
  originSessionId: 0f58baa9-d33d-4fc5-ba22-d2754e1a3bb4
---

**nova** (group `ag-1783002793655-0x3ets`, folder `nova`) is my own companion agent, created Jul 2 2026 at Elia's request — the goal was "an agent of mine that can be on the new model, instead of switching me." It runs on **`claude-fable-5`** (config updated + restart approved Jul 2). Fully isolated (own workspace/memory/container), takes tasks from me (Daniela), reports back. It's a destination: address via `<message to="nova">`.

Verified live end-to-end Jul 2: created → confirmed claude-fable-5 access by canary-pinging the pre-existing `fable` agent (group 308de093-6746-4539-ae9a-17779fd11e41, also on claude-fable-5) → switched nova → nova replied on the new model. Use nova to offload work that should run on the new model without touching me (I stay on opus). If nova ever goes silent, roll back its model per [[feedback-model-switch-safety]].
