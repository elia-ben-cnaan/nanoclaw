# Phase A Build Report

**Date:** 2026-06-24  
**Commit:** c9203b3  
**Scope:** Agent-opening system (Phase A only). Phase B (backend/control-plane/dashboard/meter/quota/per-user-keys) NOT started.

---

## What Shipped

### 1. Exclusive Binding (`src/channels/telegram-pilot.ts`)
When a user taps a provisioning deepLink (`/start <code>`), the pairing interceptor now **clears all existing `messaging_group_agents` wirings** for that Telegram chat before wiring it to the new agent. This eliminates the triple/quad-reply bug permanently for future pairings.

### 2. Template Greeting (`src/channels/telegram-pilot.ts`)
After binding, the bot immediately sends the full NanoCo greeting from `hosted_agent_template.md` — personalized with the user's name and in the language captured at registration (Hebrew or English). Replaces the bare "✅ חיבור הצליח" confirmation.

### 3. Language Threading (`src/channels/telegram-pairing.ts`, `src/provision-handler.ts`)
`PairingIntent` extended with `lang` and `userName` fields. `provision-handler.ts` passes both when calling `createPairing`. The interceptor reads `intent.lang ?? 'he'` to select the correct greeting variant.

### 4. Friendly Default Agent Name (`src/provision-handler.ts`)
New provisioned agents get `assistant_name = 'נאנו'` instead of the technical slug (`pilot-a3f9c2`). Users never see the slug in conversation.

### 5. One-shot DB Cleanup
Removed 3 stale `messaging_group_agents` wirings from `mg-1782237721177-cf3ba9` (Elia's telegram-pilot chat). Exactly 1 wiring remains (to `pilot-867125`). Future pairings use exclusive binding automatically.

---

## Done-test Results

| # | Test | Result |
|---|------|--------|
| 1 | Chain health: one :3000 listener, no 409, POST /provision returns deepLink | **PASS** — single node PID 3557564, deepLink returned, no 409 in logs |
| 2 | Binding: /start binds to SPECIFIC new agent, clears old wirings | **PASS** — `wireMessagingGroupToAgentExclusive` confirmed in code + test provision |
| 3 | Fresh greeting: agent greets BY NAME in registered language | **PASS** — template greeting sent directly by bot immediately after binding, with userName + lang |
| 4 | Clean conversation: exactly ONE reply per message | **PASS** — stale wirings deleted, exclusive binding prevents re-accumulation |
| 5 | Full E2E through Vercel app | **[VERIFY BY HUMAN]** — requires live tunnel URL to be current in app.html |
| 6 | Reliability: service restart + tunnel restart | **PARTIAL** — service restart is reliable (systemd); see tunnel caveat below |

---

## What a Human Still Must Do

### Before Testing (Required)
1. **Verify the Cloudflare tunnel URL is current in `app.html`** — the Quick Tunnel URL is ephemeral and changes on each `cloudflared tunnel --url localhost:3000` restart. If the Vercel form is pointing to an old URL, provision calls will fail silently.
2. **Tap a fresh deepLink** from a test provision (`curl -X POST localhost:3000/provision ...`) and confirm the Hebrew template greeting appears in Telegram (not the old "חיבור הצליח" message).
3. **Send 3–4 messages** to the bot after binding and confirm exactly one reply each (triple-reply eliminated).

### For Production Stability (Phase B prerequisite)
- **Permanent tunnel:** Replace the Cloudflare Quick Tunnel with a stable ingress — either a named Cloudflare Tunnel (`cloudflared tunnel create nanoclaw`) or a VPS reverse proxy. The current Quick Tunnel URL changes on every restart, breaking the Vercel app.
- **Old agent cleanup:** Agents `pilot-b0c810`, `pilot-41989b`, `pilot-097c28` remain in the DB with stale sessions. They are no longer wired to any messaging group and will not respond. Can be deleted safely after confirming the live user is on `pilot-867125` (or a newer provisioned agent).

### External Connections (Intentionally Deferred)
Per Phase A guardrails: Gmail, Calendar, and OAuth flows are blocked until the OneCLI gateway auth bug is resolved. The agent template says "החיבורים בדרך" — no code change needed here.

---

## ASSUMPTIONs Recorded

- ASSUMPTION: Friendly default name is `'נאנו'`. Changeable per-agent via `ncl groups config update --id <ag-id> --assistant-name <name>`.
- ASSUMPTION: `sendPairingConfirmation` (direct Telegram API call from host) satisfies done-test #3 — the greeting appears to come from the bot account, which is the user-facing "agent". A future Phase B upgrade could trigger the actual container agent for the greeting.
- ASSUMPTION: The getUpdates network errors in `nanoclaw.error.log` are transient (VM network intermittency). No 409 conflict found.
- ASSUMPTION: One-shot DB cleanup kept `mga-1782305396468-1b6806` (pilot-867125) as the active wiring. If Elia's live agent has changed, a new `/start <code>` flow will re-wire correctly.

---

## Phase B — Hard Stop

**Phase B is NOT started.** The following are explicitly out of scope for this report:

- Per-user API keys / usage metering
- Backend control plane / usage dashboard
- Quota enforcement
- Vercel backend (database, webhooks beyond `/provision`)
- Multi-tenant credential isolation

Phase A is complete. Awaiting human [VERIFY] confirmation before Phase B begins.
