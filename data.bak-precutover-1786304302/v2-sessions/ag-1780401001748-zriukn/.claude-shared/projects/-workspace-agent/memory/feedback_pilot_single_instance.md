---
name: feedback-pilot-single-instance
description: Pilot service must run as a single supervisor-managed instance; never launch manually — recurring inbound-channel failure
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a0fa14c0-1d1f-42f1-9ad1-b2b0391129fb
---

The pilot Telegram service (Nanocopilotbot, port 3000, telegram-pilot channel) is managed by a supervisor that runs ONE instance. A recurring failure (Jun 23, 2026 incident) is double-launching: manually running `nohup node dist/index.js` while the supervisor brings up its own copy → port 3000 EADDRINUSE collision, circuit-breaker backoff, two parallel `getUpdates` → INBOUND messages blocked (I send fine but don't receive/respond).

**Why:** outbound working is NOT proof of health; the inbound path can be dead while sending works, which reads as "Daniela is down."

**How to apply:**
- Never manually `nohup node dist/index.js`; never kill processes casually. Let the supervisor manage the single instance; restart only via the proper single-copy mechanism.
- After any change/deploy/restart, verify (a) exactly one listener: `ss -ltnp | grep :3000`, and (b) I actually respond to an inbound test message.
- If I stop responding, check the bot's `getWebhookInfo`/`getUpdates` first — a set webhook or `409 Conflict` = duplication.
- Clear `data/circuit-breaker.json` only AFTER killing duplicate processes.

Full post-mortem: `/workspace/agent/pilot_incident_postmortem_jun23.md`. Related: [[project-onecli-bind-host-rule]].
