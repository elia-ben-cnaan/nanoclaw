---
name: project_daniela_vm_terminal
description: "The browser terminal + VM to send Elia to for pilot/provision work is daniela (daniela.xterm.exe.xyz), NOT eliabc"
metadata: 
  node_type: memory
  type: project
  originSessionId: a0fa14c0-1d1f-42f1-9ad1-b2b0391129fb
---

For ANY pilot/provision/Nanocopilotbot work, Elia must use the **daniela** VM, reached via its browser terminal **https://daniela.xterm.exe.xyz** (the `?name=...` query is just a tab color, ignore it). The terminal header reads "daniela - Terminal" and prints "You are on daniela.exe.xyz... You have 'sudo'." Claude Code (`claude`) is installed there.

Do NOT send him to **eliabc** (eliabc.exe.xyz / eliabc.xterm.exe.xyz) for pilot work — that VM runs Daniela's OWN agent (nanoclaw-v2) and has NONE of the pilot/provision code.

**Why:** all pilot code (provision-handler.ts, telegram-pilot.ts, telegram-pairing.ts, the /provision webhook + telegram-pilot channel on port 3000, the Nanocopilotbot) lives ONLY on daniela. Elia confirmed Jun 23, 2026 (#4580) and asked me to remember this so I always route him to the right terminal. We habitually work on eliabc, which caused earlier wasted effort (the bot token was once applied to eliabc = inert).

**How to apply:** when a task touches the pilot, tell him to open https://daniela.xterm.exe.xyz and confirm the header says daniela before running anything. Related: [[feedback-pilot-single-instance]].
