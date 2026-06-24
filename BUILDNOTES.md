# Phase A Build Notes

## Pre-flight Findings

### Chain Health (V2 Pre-flight)
- Port :3000: exactly one `node` listener (PID confirmed after each restart)
- `POST /provision` with `HOST_PROVISION_TOKEN`: returns `{ deepLink: "https://t.me/Nanoco_pilot_bot?start=XXXX" }`
- No 409 Telegram conflicts in error log — bot has single poller
- `data/circuit-breaker.json` showed attempt=1 at session start (normal)

### V1/V4 (credential/OneCLI gating)
- [VERIFY] Phase A runs on shared `claude-sonnet-4-6` credential via OneCLI gateway
- V1/V4 (per-user keys, usage metering) are Phase B — deliberately not implemented here

## Root Cause: Triple-reply Bug

**Confirmed:** `messaging_group_id = mg-1782237721177-cf3ba9` (Elia's `telegram-pilot` chat) had 4 rows in `messaging_group_agents`:
```
mga-1782237721177-3ef832 → pilot-b0c810
mga-1782244463032-8ca38c → pilot-41989b
mga-1782279669233-3e727b → pilot-097c28
mga-1782305396468-1b6806 → pilot-867125  ← kept (most recent)
```
Every inbound message fanned out to all 4 active agents → 4 replies.

**Root cause:** `wireMessagingGroupToAgent` only checked if the new pair existed — it never removed old wirings. Each `/start <code>` accumulated a new wiring without clearing previous ones.

## Fixes Applied

### 1. Exclusive Binding (`src/channels/telegram-pilot.ts`)
Renamed `wireMessagingGroupToAgent` → `wireMessagingGroupToAgentExclusive`. Before inserting a new wiring, deletes ALL existing `messaging_group_agents` rows for the messaging group. Imports `getMessagingGroupAgents` + `deleteMessagingGroupAgent` (both pre-existed in `src/db/messaging-groups.ts`).

### 2. Template Greeting (`src/channels/telegram-pilot.ts`)
`sendPairingConfirmation` now takes `lang: string` and sends the full template greeting from `hosted_agent_template.md` (Hebrew) or English variant. Name personalization via `userName` already in the call.

### 3. Lang in PairingIntent (`src/channels/telegram-pairing.ts`)
Extended `PairingIntent` `new-agent` variant: `{ kind: 'new-agent'; folder: string; lang?: string; userName?: string }`.

### 4. Friendly Name (`src/provision-handler.ts`)
Changed `assistant_name: slug` → `assistant_name: 'נאנו'`. Also passes `lang` + `userName` to `createPairing` so the greeting interceptor can personalize correctly.

### 5. One-shot DB Cleanup
Deleted the 3 stale wirings for `mg-1782237721177-cf3ba9` via SQL, leaving only `mga-1782305396468-1b6806` (pilot-867125). Verified: 1 row remains.

## ASSUMPTIONs

- ASSUMPTION: Friendly default name is `'נאנו'` (NanoCo's brand term). Changeable post-Phase-A via `ncl groups config update`.
- ASSUMPTION: Cloudflare Quick Tunnel (`cloudflared tunnel --url localhost:3000`) is a development tool — the URL is ephemeral and changes on each tunnel restart. Production requires a stable ingress (Vercel proxy, permanent Cloudflare tunnel, or reverse proxy). Documented in BUILDREPORT.md.
- ASSUMPTION: The getUpdates network errors in `nanoclaw.error.log` are transient (VM network intermittency, not a 409 conflict). Confirmed no 409 in error log.
- ASSUMPTION: Old pilot agent groups (pilot-867125, pilot-097c28, etc.) remain in the DB with slug as `assistant_name`. They are superseded by exclusive binding — future `/start` codes will overwrite the wiring to whatever new agent the provision creates.

## Bug Fix (post-Phase A): Registered Name in Greeting

**Bug:** Greeting used Telegram profile name ("Elia Ben Cnaan") instead of the form-registered name ("עדי לוסקי").

**Root cause:** `const userName = consumed.consumed!.name || 'User';` at line 161 pulled `ConsumedDetails.name` (Telegram senderName) before `intent` was declared (line 194). `intent.userName` was never read.

**Fix:** Hoisted `intent` extraction above `userName`. Now uses `intent.userName?.trim()` with fallback to Telegram profile name → `'User'`. Verified: `data/telegram-pairings.json` shows `intent.userName = "עדי לוסקי"` for a test provision with that name.

## [VERIFY] Items for Human Review

- [VERIFY] Tap a fresh deepLink and confirm the bot sends the Hebrew template greeting (not the old "חיבור הצליח" message)
- [VERIFY] Send 3–4 messages to the bot after binding — confirm exactly ONE reply each (triple-reply eliminated)
- [VERIFY] Full E2E: submit the Vercel form → receive deepLink → tap → get greeting → chat cleanly
- [VERIFY] Tunnel stability: if the Cloudflare Quick Tunnel URL changes, the Vercel app must be updated with the new URL. Consider a permanent tunnel or VPS reverse proxy for production.
- [VERIFY] Existing sessions for `pilot-867125` (last active agent before cleanup) may still have active containers that could respond briefly before expiring. They will stop after their session containers time out.
