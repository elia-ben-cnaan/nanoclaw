---
name: reference_nanoclaw_pr3012_memory
description: NanoClaw PR
metadata: 
  node_type: memory
  type: reference
  originSessionId: 83688248-a490-4718-bb54-db3275a6f49a
---

**PR:** https://github.com/nanocoai/nanoclaw/pull/3012 — `feat(memory): add provider-agnostic persistent memory`. **MERGED Jul 15 2026** (core infra, NOT a separate plugin).

What it does: unified memory tree per agent group (`memory/index.md`, `memory/system/definition.md`), loaded on startup / after clear / after compaction (not resume). Replaces legacy `CLAUDE.local.md` composition with shared instructions files. Uses Claude's session-start hook while preserving user hooks. Ships `/migrate-memory` command to move legacy stores without data loss. Point: **NanoClaw stays the single persistent-memory authority across Claude/Codex/future providers** — memory survives provider switches without duplication or loss.

This is the exact system in **Amit Shafnir's** (Founding AI Engineer @ NanoCo) LinkedIn post (screenshot saved Jul 16) — the memory-as-file-tree diagram (Memory→People/Projects/Topics→Alice/Bob/Facts/Decisions…). It's literally the `MEMORY.md` + `memory/*.md` system I run on.

Repo: https://github.com/nanocoai/nanoclaw

**Elia's angle (#30684):** wants to know it, maybe surface it as a תוסף/feature we point users to. Honest note: it's already merged core, so "adding as a plugin" = more about featuring/explaining it in our guide/app than installing it.

**⚠️ CORRECTION (Jul 17, #32882 — Claude Code verified the actual repo, not the LinkedIn post):** The post is slightly marketing-exaggerated. Ground truth from the repo's own `docs/provider-migration.md` + git log (commits 25b820ca feat(memory), c542c46d OKF-compatible bundles, refactor use-agent-defined-folder-tree): (1) The memory-tree/OKF feature IS real and **already present in v2.1.24 which the daniela VM already runs** — `update-nanoclaw` would change ~nothing. (2) It is NOT auto "provider-agnostic" in the Codex sense — **each provider keeps a SEPARATE store** (Claude=`CLAUDE.local.md`, Codex=`memory/`). Switching provider does NOT migrate memory by itself; you must run **`/migrate-memory`** (a real command). (3) My agent already has `fallbackProvider: codex` working automatically (fallback-on-quota, commits 41825577/6493a2ca) — so a Claude quota drop already auto-switches me to Codex; DON'T break that. (4) The ONLY gap: at the fallback moment Codex's `memory/` is EMPTY unless `/migrate-memory` was run in advance = the "you forget / behave differently on Codex" pain. Fix = prep, not a fire. **DECISION: backlog, NOT urgent.** Trigger to act = first time Elia sees me lose a thread after a REAL quota fallback. Safe path if/when done: (a) test `/migrate-memory` + provider switch on an idle old pilot (e.g. pilot-6d6003) first, (b) only then me, with `--provider none` rollback ready. Do NOT re-present this as urgent. See [[project_pilot_reflection_jul16]].
