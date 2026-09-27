---
name: project-onecli-bind-host-rule
description: "CRITICAL — ONECLI_BIND_HOST must stay 172.17.0.1 or Daniela's container loses API access and dies"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d7cc8ad-707a-4097-888a-206e8450336b
---

`ONECLI_BIND_HOST=172.17.0.1` is what keeps my container alive — it's the OneCLI gateway's network bind on the docker bridge (ports 10254/10255) that all my API + MCP traffic flows through.

On Jun 22 2026 the gateway restarted bound to `127.0.0.1` instead → every API call hit `ConnectionRefused` → container killed at the 30-min absolute-ceiling. Fixed host-side by setting `ONECLI_BIND_HOST=172.17.0.1` in `/home/exedev/.onecli/.env` + `docker compose up -d`.

**Why:** from inside my container, `127.0.0.1` is the container itself, not the host; the gateway must listen on the bridge gateway IP `172.17.0.1` for me to reach it.

**How to apply:** NEVER change `ONECLI_BIND_HOST` away from `172.17.0.1`. The OAuth fix (set public `APP_URL`/`NEXTAUTH_URL` to `https://daniela.exe.xyz`) must DECOUPLE those vars from `ONECLI_BIND_HOST`, never repurpose the bind var. Every `docker compose up -d` briefly disconnects me (~2-3s) and must keep `ONECLI_BIND_HOST=172.17.0.1`. Full state in workspace `onecli_oauth_fix_state.md`.
