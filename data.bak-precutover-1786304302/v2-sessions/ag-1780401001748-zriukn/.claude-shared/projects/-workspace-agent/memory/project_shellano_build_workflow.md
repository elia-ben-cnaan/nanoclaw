---
name: project_shellano_build_workflow
description: "shellano.com build workflow — Builder writes code, Daniela reviews+deploys; Daniela now on Opus 4.8"
metadata: 
  node_type: memory
  type: project
  originSessionId: dc39f4ea-4c2e-4060-999c-ca445e3c19d4
---

shellano.com (Vercel project `nanoshellano-site`, working file `nanohub_demo/shellano-v4.html`) UX overhaul.

**Jul 10 2026 decision (Elia #22996-#23000):** Daniela's direct-edit of shellano caused errors (deployed an OLD file over the good live version). From now:
- **Builder writes the shellano code** (like it did for the guide index.html), returns to Daniela; Daniela reviews + deploys (Vercel token is Daniela's).
- **Daniela switched to claude-opus-4-8** (was Sonnet) for higher precision — approved by Elia, applied + restarted Jul 10 04:45 UTC.
- Work the app **step by step** ("צעד צעד") — one change at a time, verify, then next.

Root cause of the Jul 9 mess: worked from a stale `shellano-v4.html` in workspace without checking what was live. Always pull/verify live state before editing. See [[feedback_model_tiering]].
