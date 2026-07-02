/**
 * Operator dashboard for the hosted NanoCo pilot — Elia only.
 *
 * Served from the existing webhook server on :3000 (no new process/port —
 * single supervisor-managed instance). Every route is gated behind a
 * non-guessable key passed as `?key=<ADMIN_KEY>` (env var ADMIN_KEY), the same
 * URL-key pattern as the leads dashboard.
 *
 * Routes (all require ?key=ADMIN_KEY):
 *   GET  /admin                       → HTML operator view
 *   GET  /admin/agents                → JSON list of provisioned pilot agents
 *   GET  /admin/agent/:slug           → JSON detail for one agent
 *   POST /admin/agent/:slug/pause     → stop the agent from responding
 *   POST /admin/agent/:slug/resume    → re-enable responses
 *   POST /admin/agent/:slug/delete    → cascade-delete the agent (confirm in UI)
 *
 * Hard rules honored here:
 *   - Never expose pairing codes / tokens / keys in any response.
 *   - Real data only. A value with no real source is returned as null and
 *     rendered as "—" with a TODO marker — never faked.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { getDb } from './db/connection.js';
import { getAgentGroupByFolder, getAllAgentGroups } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import {
  rollupUsageForAgent,
  getUsageForDay,
  getUsageHistory,
  getUsageTotals,
  effectiveCostCapUsd,
  type DayUsage,
} from './db/usage-metering.js';
import { restartAgentGroupContainers } from './container-restart.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

const ADMIN_KEY: string = (() => {
  const fromEnv = readEnvFile(['ADMIN_KEY']);
  return fromEnv['ADMIN_KEY'] || process.env['ADMIN_KEY'] || '';
})();

const PAIRINGS_FILE = path.join(DATA_DIR, 'telegram-pairings.json');

// ─── metering config ─────────────────────────────────────────────────────────
// Token/cost metering is computed in src/db/usage-metering.ts (tiered
// claude-sonnet-4-6 pricing, accurate per cache tier). Display only — no
// enforcement.

/** Daily token cap shown in the usage bar. No per-agent cap field exists in the
 *  schema, so this is a single configurable default via env (display only). */
const DAILY_TOKEN_CAP: number = (() => {
  const fromEnv = readEnvFile(['PILOT_DAILY_TOKEN_CAP']);
  const raw = fromEnv['PILOT_DAILY_TOKEN_CAP'] || process.env['PILOT_DAILY_TOKEN_CAP'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5_000_000; // documented default
})();

/**
 * engage_pattern sentinel used to pause an agent. It is a VALID regex (an empty
 * negative lookahead) that can never match any message — paused agents drop
 * inbound messages instead of engaging. It must stay valid: evaluateEngage()
 * fails OPEN on an invalid regex, which would un-pause the agent. Resume
 * restores the pilot default pattern '.'.
 */
const PAUSE_SENTINEL = '(?!)';
const LIVE_PATTERN = '.';

// ─── auth ──────────────────────────────────────────────────────────────────

function keyOk(provided: string | null): boolean {
  if (!ADMIN_KEY || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── data assembly ───────────────────────────────────────────────────────────

interface PairingInfo {
  userName: string | null;
  pairingStatus: string | null; // pending | consumed | invalidated
  createdAt: string | null;
}

/** Read the registration name + pairing status for a slug. Never returns the code. */
function readPairingInfo(folder: string): PairingInfo {
  try {
    const raw = fs.readFileSync(PAIRINGS_FILE, 'utf8');
    const store = JSON.parse(raw) as {
      pairings: Array<{
        intent?: { kind?: string; folder?: string; userName?: string };
        status?: string;
        createdAt?: string;
      }>;
    };
    // Most-recent matching new-agent record wins.
    const matches = store.pairings.filter(
      (p) => p.intent && p.intent.kind === 'new-agent' && p.intent.folder === folder,
    );
    const rec = matches[matches.length - 1];
    if (!rec) return { userName: null, pairingStatus: null, createdAt: null };
    return {
      userName: rec.intent?.userName?.trim() || null,
      pairingStatus: rec.status ?? null,
      createdAt: rec.createdAt ?? null,
    };
  } catch {
    return { userName: null, pairingStatus: null, createdAt: null };
  }
}

interface WiringRow {
  wiring_id: string;
  engage_pattern: string | null;
  engage_mode: string | null;
  platform_id: string | null;
  mg_name: string | null;
}

function getPilotWiring(agentGroupId: string): WiringRow | undefined {
  return getDb()
    .prepare(
      `SELECT mga.id AS wiring_id, mga.engage_pattern, mga.engage_mode, mg.platform_id, mg.name AS mg_name
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       WHERE mga.agent_group_id = ?
       ORDER BY mga.created_at LIMIT 1`,
    )
    .get(agentGroupId) as WiringRow | undefined;
}

/** Count exchanged messages from the session DBs. Returns null if unreadable. */
function countMessages(agentGroupId: string, sessionId: string): number | null {
  let total = 0;
  let sawAny = false;
  try {
    const inP = inboundDbPath(agentGroupId, sessionId);
    if (fs.existsSync(inP)) {
      const d = new Database(inP, { readonly: true });
      try {
        total += (d.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE kind = 'chat-sdk'").get() as { c: number }).c;
        sawAny = true;
      } finally {
        d.close();
      }
    }
    const outP = outboundDbPath(agentGroupId, sessionId);
    if (fs.existsSync(outP)) {
      const d = new Database(outP, { readonly: true });
      try {
        total += (d.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
        sawAny = true;
      } finally {
        d.close();
      }
    }
  } catch (err) {
    log.warn('admin: message count failed', { agentGroupId, sessionId, err });
    return null;
  }
  return sawAny ? total : null;
}

function localDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
}

interface AgentView {
  slug: string;
  agentGroupId: string;
  friendlyName: string | null;
  userName: string | null;
  telegramChat: string | null;
  status: 'pending-pair' | 'live' | 'paused';
  liveNow: boolean;
  createdAt: string | null;
  lastActiveAt: string | null;
  messageCount: number | null;
  tokensTodayIn: number; // input-side tokens (incl. cache) used today (UTC)
  tokensTodayOut: number; // output tokens used today (UTC)
  tokensToday: number; // in + out
  estCostTodayUsd: number; // tiered per-model pricing on today's tokens
  capLimit: number; // daily token cap (env PILOT_DAILY_TOKEN_CAP, display only)
  capRemaining: number; // capLimit - tokensToday, floored at 0
  costCapUsd: number; // effective daily cost cap (enforced) — per-agent or default
  costCapReached: boolean; // estCostTodayUsd >= costCapUsd (agent is gated)
  model: string | null;
  connections: string[];
}

function buildAgentView(folder: string): AgentView | null {
  const ag = getAgentGroupByFolder(folder);
  if (!ag) return null;

  const config = getContainerConfig(ag.id);
  let connections: string[] = [];
  if (config?.mcp_servers) {
    try {
      connections = Object.keys(JSON.parse(config.mcp_servers));
    } catch {
      connections = [];
    }
  }

  const wiring = getPilotWiring(ag.id);
  const pairing = readPairingInfo(folder);

  const sessions = getSessionsByAgentGroup(ag.id);
  const sess = sessions.find((s) => s.status === 'active') ?? sessions[0];
  const containerStatus = sess?.container_status ?? 'stopped';
  const liveNow = containerStatus === 'running' || containerStatus === 'idle';

  let status: AgentView['status'];
  if (!wiring) status = 'pending-pair';
  else if (wiring.engage_pattern === PAUSE_SENTINEL) status = 'paused';
  else status = 'live';

  // Bring the durable rollup current for this agent, then read today from it.
  // (Self-rolling here keeps every view fresh regardless of caller, and keeps
  // history accruing even for agents whose detail page is never opened.)
  try {
    rollupUsageForAgent(ag.id);
  } catch (err) {
    log.warn('admin: usage rollup failed', { agentGroupId: ag.id, err });
  }
  const usage = getUsageForDay(ag.id);
  const tokensToday = usage.tokens;

  return {
    slug: folder,
    agentGroupId: ag.id,
    friendlyName: config?.assistant_name || null,
    userName: pairing.userName,
    telegramChat: wiring?.platform_id ?? null,
    status,
    liveNow,
    createdAt: ag.created_at ?? null,
    lastActiveAt: sess?.last_active ?? null,
    messageCount: sess ? countMessages(ag.id, sess.id) : 0,
    tokensTodayIn: usage.inTokens,
    tokensTodayOut: usage.outTokens,
    tokensToday,
    estCostTodayUsd: usage.costUsd,
    capLimit: DAILY_TOKEN_CAP,
    capRemaining: Math.max(0, DAILY_TOKEN_CAP - tokensToday),
    costCapUsd: effectiveCostCapUsd(ag.id),
    costCapReached: usage.costUsd >= effectiveCostCapUsd(ag.id),
    model: config?.model || null,
    connections,
  };
}

function listPilotFolders(): string[] {
  return getAllAgentGroups()
    .filter((g) => g.folder.startsWith('pilot-'))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) // newest first
    .map((g) => g.folder);
}

function buildAllAgents(): AgentView[] {
  const views: AgentView[] = [];
  for (const folder of listPilotFolders()) {
    const v = buildAgentView(folder);
    if (v) views.push(v);
  }
  return views;
}

function buildKpis(agents: AgentView[]): Record<string, number | null> {
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const activeToday = agents.filter((a) => a.lastActiveAt && localDateKey(a.lastActiveAt) === todayKey).length;
  const totalMessages = agents.reduce((sum, a) => sum + (a.messageCount ?? 0), 0);
  const tokensToday = agents.reduce((sum, a) => sum + a.tokensToday, 0);
  const estCostTodayUsd = Math.round(agents.reduce((sum, a) => sum + a.estCostTodayUsd, 0) * 10000) / 10000;
  return {
    totalAgents: agents.length,
    liveNow: agents.filter((a) => a.liveNow).length,
    activeToday,
    totalMessages,
    tokensToday,
    estCostTodayUsd,
  };
}

// ─── actions ─────────────────────────────────────────────────────────────────

function setEngagePattern(agentGroupId: string, pattern: string): number {
  return getDb()
    .prepare("UPDATE messaging_group_agents SET engage_pattern = ?, engage_mode = 'pattern' WHERE agent_group_id = ?")
    .run(pattern, agentGroupId).changes;
}

function pauseAgent(agentGroupId: string): { paused: boolean; wiringsUpdated: number; containersKilled: number } {
  const wiringsUpdated = setEngagePattern(agentGroupId, PAUSE_SENTINEL);
  const containersKilled = restartAgentGroupContainers(agentGroupId, 'paused via admin dashboard');
  return { paused: true, wiringsUpdated, containersKilled };
}

function resumeAgent(agentGroupId: string): { resumed: boolean; wiringsUpdated: number } {
  const wiringsUpdated = setEngagePattern(agentGroupId, LIVE_PATTERN);
  return { resumed: true, wiringsUpdated };
}

/** FK-ordered cascade delete (mirrors `ncl groups delete`) + container kill. */
function deleteAgent(agentGroupId: string): { deleted: string; removed: Record<string, number> } {
  // 0. Capture this agent's final usage into the durable rollup BEFORE its
  //    sessions (and their usage_events) are removed — so historical spend is
  //    retained in usage_daily even after the agent is gone.
  try {
    rollupUsageForAgent(agentGroupId);
  } catch (err) {
    log.warn('admin: pre-delete usage rollup failed', { agentGroupId, err });
  }

  // 1. Kill any running container first so it can't write mid-delete.
  restartAgentGroupContainers(agentGroupId, 'deleted via admin dashboard');

  const db = getDb();
  const cascade = db.transaction((groupId: string) => {
    const removed: Record<string, number> = {};
    removed.agent_destinations_owned = db
      .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
      .run(groupId).changes;
    removed.agent_destinations_pointing = db
      .prepare("DELETE FROM agent_destinations WHERE target_type = 'agent' AND target_id = ?")
      .run(groupId).changes;
    removed.pending_questions = db
      .prepare('DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)')
      .run(groupId).changes;
    removed.pending_approvals = db
      .prepare(
        'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
      )
      .run(groupId, groupId).changes;
    removed.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(groupId).changes;
    removed.messaging_group_agents = db
      .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
      .run(groupId).changes;
    removed.agent_group_members = db
      .prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?')
      .run(groupId).changes;
    removed.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(groupId).changes;
    removed.container_configs = db
      .prepare('DELETE FROM container_configs WHERE agent_group_id = ?')
      .run(groupId).changes;
    removed.agent_groups = db.prepare('DELETE FROM agent_groups WHERE id = ?').run(groupId).changes;
    return removed;
  });
  const removed = cascade(agentGroupId);
  // On-disk cleanup is done by the caller via cleanupAgentDisk(folder) — it
  // needs the folder name, which the caller still has after the row is gone.
  return { deleted: agentGroupId, removed };
}

/** Remove on-disk dirs for a deleted agent, guarded against path escape. */
function cleanupAgentDisk(agentGroupId: string, folder: string): string[] {
  const cleaned: string[] = [];
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  const candidates: Array<{ root: string; target: string }> = [
    { root: path.resolve(GROUPS_DIR), target: path.resolve(GROUPS_DIR, folder) },
    { root: path.resolve(sessionsRoot), target: path.resolve(sessionsRoot, agentGroupId) },
  ];
  for (const { root, target } of candidates) {
    try {
      const rel = path.relative(root, target);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue; // escape guard
      if (!fs.existsSync(target)) continue;
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) continue;
      fs.rmSync(target, { recursive: true, force: true });
      cleaned.push(target);
    } catch (err) {
      log.warn('admin: disk cleanup failed', { agentGroupId, folder, target, err });
    }
  }
  return cleaned;
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function renderPage(adminKey: string): string {
  // The key is echoed into the page so its fetch()/POST calls stay authorized
  // — same exposure surface as the ?key= URL the operator already loaded.
  const keyJson = JSON.stringify(adminKey);
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>NanoCo · Operator</title>
<style>
  :root{
    --bg:#0b0f14; --panel:#121922; --panel2:#0f151d; --line:#1f2a37;
    --txt:#e6edf3; --muted:#8aa0b2; --accent:#2dd4bf; --accent2:#22d3ee;
    --green:#34d399; --amber:#fbbf24; --red:#f87171; --grey:#64748b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans Hebrew",sans-serif;
    -webkit-font-smoothing:antialiased;padding:16px;max-width:1100px;margin:0 auto}
  header{display:flex;align-items:center;gap:10px;margin:6px 4px 18px}
  .logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));
    display:flex;align-items:center;justify-content:center;font-weight:800;color:#04231f}
  h1{font-size:18px;margin:0;font-weight:700}
  .sub{color:var(--muted);font-size:12px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
  .kpi .v{font-size:22px;font-weight:800;letter-spacing:.5px}
  .kpi .l{color:var(--muted);font-size:11px;margin-top:2px}
  .kpi .todo{color:var(--amber);font-size:10px;margin-top:3px;opacity:.85}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .name{font-weight:700;font-size:15px}
  .slug{color:var(--muted);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
  .b-live{background:rgba(52,211,153,.15);color:var(--green);border:1px solid rgba(52,211,153,.35)}
  .b-pending{background:rgba(100,116,139,.15);color:#a8b6c5;border:1px solid rgba(100,116,139,.4)}
  .b-paused{background:rgba(251,191,36,.13);color:var(--amber);border:1px solid rgba(251,191,36,.35)}
  .meta{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:10px 0;font-size:12.5px}
  .meta .k{color:var(--muted)}
  .meta .v{color:var(--txt);word-break:break-word}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-inline-start:6px;vertical-align:middle}
  .dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  .dot.off{background:var(--grey)}
  .bar{height:7px;background:var(--panel2);border:1px solid var(--line);border-radius:999px;overflow:hidden;margin-top:3px}
  .bar > i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2))}
  .usage .lbl{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:3px}
  .conns{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
  .chip{font-size:10.5px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);
    padding:2px 7px;border-radius:999px}
  .actions{display:flex;gap:8px;margin-top:12px}
  button{flex:1;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;
    padding:8px 0;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);
    transition:filter .15s}
  button:hover{filter:brightness(1.25)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .b-pause{border-color:rgba(251,191,36,.4);color:var(--amber)}
  .b-resume{border-color:rgba(52,211,153,.4);color:var(--green)}
  .b-del{border-color:rgba(248,113,113,.4);color:var(--red)}
  .empty,.err{color:var(--muted);text-align:center;padding:40px 10px}
  .err{color:var(--red)}
  .todo{color:var(--amber)}
  footer{color:var(--muted);font-size:11px;text-align:center;margin-top:24px}
  .refresh{background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;flex:none}
  .histbtn{width:100%;margin-top:8px;background:none;border:1px dashed var(--line);color:var(--muted);
    border-radius:9px;padding:7px 0;font-size:12px;cursor:pointer}
  .histbtn:hover{color:var(--accent);border-color:var(--accent)}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;padding:16px;z-index:50}
  .modal.open{display:flex}
  .sheet{background:var(--panel);border:1px solid var(--line);border-radius:14px;max-width:560px;width:100%;
    max-height:85vh;overflow:auto;padding:18px}
  .sheet h2{font-size:16px;margin:0 0 2px}
  .sheet .sub{margin-bottom:14px}
  .totrow{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
  .tot{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:9px 10px}
  .tot .v{font-size:16px;font-weight:800}
  .tot .l{font-size:10.5px;color:var(--muted)}
  .hrow{display:grid;grid-template-columns:84px 1fr auto;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--line);font-size:12px}
  .hrow .d{color:var(--muted);font-family:ui-monospace,Menlo,monospace}
  .hbar{height:8px;background:var(--panel2);border-radius:999px;overflow:hidden}
  .hbar > i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2))}
  .hcost{font-weight:700;text-align:left;min-width:62px}
  .closex{float:left;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
</style>
</head>
<body>
<header>
  <div class="logo">N</div>
  <div style="flex:1">
    <h1>NanoCo · תצוגת תפעול</h1>
    <div class="sub">ניטור וניהול סוכני הפיילוט · Elia בלבד</div>
  </div>
  <button class="refresh" onclick="load()">↻ רענון</button>
</header>
<div id="kpis" class="kpis"></div>
<div id="cards" class="cards"><div class="empty">טוען…</div></div>
<div id="modal" class="modal" onclick="if(event.target===this)closeHist()"><div id="sheet" class="sheet"></div></div>
<footer>מדידת טוקנים פר-turn (כולל cache) · עלות בתמחור מדורג לפי מודל (haiku-4-5: in $1 / out $5 · sonnet-4-6: in $3 / out $15 ל-1M, cache read 0.1x / write 1.25x) · תקרת עלות יומית per-agent נאכפת (ברירת מחדל $1/יום) · היסטוריה נשמרת לאורך זמן</footer>
<script>
const KEY = ${keyJson};
const q = (s)=>document.querySelector(s);
const dash = (v)=> (v===null||v===undefined||v==='') ? '<span class="todo">— TODO</span>' : v;
const fmtDate = (iso)=>{ if(!iso) return null; try{ return new Date(iso).toLocaleString('he-IL',{dateStyle:'short',timeStyle:'short'}); }catch(e){ return iso; } };
const esc = (s)=> String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtNum = (n)=> (n===null||n===undefined) ? null : Number(n).toLocaleString('en-US');
const fmtUsd = (n)=> (n===null||n===undefined) ? null : '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

function badge(st){
  if(st==='live') return '<span class="badge b-live">LIVE</span>';
  if(st==='paused') return '<span class="badge b-paused">מושהה</span>';
  return '<span class="badge b-pending">ממתין לזיווג</span>';
}

function usageBar(a){
  if(a.tokensToday===null || a.capLimit===null){
    return '<div class="usage"><div class="lbl"><span>טוקנים היום</span><span class="todo">— TODO</span></div>'+
           '<div class="bar"><i style="width:0%"></i></div></div>';
  }
  const pct = a.capLimit>0 ? Math.min(100, Math.round(a.tokensToday/a.capLimit*100)) : 0;
  const hot = pct>=90 ? ' style="filter:hue-rotate(-50deg)"' : '';
  return '<div class="usage"><div class="lbl"><span>טוקנים היום ('+pct+'%)</span><span>'+fmtNum(a.tokensToday)+' / '+fmtNum(a.capLimit)+'</span></div>'+
         '<div class="bar"><i'+hot+' style="width:'+pct+'%"></i></div>'+
         '<div class="lbl" style="margin-top:4px"><span>in '+fmtNum(a.tokensTodayIn)+' · out '+fmtNum(a.tokensTodayOut)+'</span><span>'+fmtUsd(a.estCostTodayUsd)+'</span></div></div>';
}

function card(a){
  const conns = (a.connections&&a.connections.length)
    ? a.connections.map(c=>'<span class="chip">'+esc(c)+'</span>').join('')
    : '<span class="todo">—</span>';
  const last = fmtDate(a.lastActiveAt);
  const canPause = a.status==='live';
  const canResume = a.status==='paused';
  return '<div class="card">'+
    '<div class="row"><div><div class="name">'+dash(a.friendlyName?esc(a.friendlyName):null)+
      '<span class="dot '+(a.liveNow?'on':'off')+'"></span></div>'+
      '<div class="slug">'+esc(a.slug)+'</div></div>'+badge(a.status)+'</div>'+
    '<div class="meta">'+
      '<span class="k">משתמש</span><span class="v">'+dash(a.userName?esc(a.userName):null)+'</span>'+
      '<span class="k">צ׳אט טלגרם</span><span class="v">'+dash(a.telegramChat?esc(a.telegramChat):null)+'</span>'+
      '<span class="k">מודל</span><span class="v">'+dash(a.model?esc(a.model):null)+'</span>'+
      '<span class="k">הודעות</span><span class="v">'+dash(a.messageCount)+'</span>'+
      '<span class="k">פעיל לאחרונה</span><span class="v">'+dash(last)+'</span>'+
      '<span class="k">תקרת עלות/יום</span><span class="v">'+fmtUsd(a.estCostTodayUsd)+' / '+fmtUsd(a.costCapUsd)+
        (a.costCapReached?' <span class="badge b-paused">תקרה הושגה</span>':'')+'</span>'+
      '<span class="k">חיבורים</span><span class="v conns">'+conns+'</span>'+
    '</div>'+
    usageBar(a)+
    '<button class="histbtn" onclick="showHist(\\''+a.slug+'\\')">📊 היסטוריה ועלות מצטברת ›</button>'+
    '<div class="actions">'+
      '<button class="b-pause" '+(canPause?'':'disabled')+' onclick="act(\\''+a.slug+'\\',\\'pause\\')">השהה</button>'+
      '<button class="b-resume" '+(canResume?'':'disabled')+' onclick="act(\\''+a.slug+'\\',\\'resume\\')">הפעל</button>'+
      '<button class="b-del" onclick="del(\\''+a.slug+'\\',\\''+esc(a.friendlyName||a.slug)+'\\')">מחק</button>'+
    '</div>'+
  '</div>';
}

function kpi(v,l,todo){
  return '<div class="kpi"><div class="v">'+(v===null?'<span class="todo">—</span>':v)+'</div><div class="l">'+l+'</div>'+
    (todo?'<div class="todo">'+todo+'</div>':'')+'</div>';
}

async function load(){
  try{
    const r = await fetch('/admin/agents?key='+encodeURIComponent(KEY));
    if(!r.ok){ q('#cards').innerHTML='<div class="err">שגיאת הרשאה ('+r.status+')</div>'; return; }
    const d = await r.json();
    const k = d.kpis;
    q('#kpis').innerHTML =
      kpi(fmtNum(k.totalAgents),'סך סוכנים')+
      kpi(fmtNum(k.liveNow),'Live עכשיו')+
      kpi(fmtNum(k.activeToday),'פעילים היום')+
      kpi(fmtNum(k.totalMessages),'סך הודעות')+
      kpi(fmtNum(k.tokensToday),'טוקנים היום')+
      kpi(fmtUsd(k.estCostTodayUsd),'עלות משוערת היום','תמחור מדורג לפי מודל');
    q('#cards').innerHTML = d.agents.length ? d.agents.map(card).join('') : '<div class="empty">אין סוכנים עדיין</div>';
  }catch(e){ q('#cards').innerHTML='<div class="err">'+esc(e.message)+'</div>'; }
}

async function act(slug, action){
  try{
    const r = await fetch('/admin/agent/'+encodeURIComponent(slug)+'/'+action+'?key='+encodeURIComponent(KEY),{method:'POST'});
    if(!r.ok){ alert('פעולה נכשלה ('+r.status+')'); return; }
    load();
  }catch(e){ alert(e.message); }
}

async function del(slug, name){
  if(!confirm('למחוק לצמיתות את הסוכן "'+name+'" ('+slug+')?\\nכל ההיסטוריה והקבצים יימחקו. אין שחזור.')) return;
  if(!confirm('אישור אחרון: מחיקה בלתי הפיכה של '+slug+'.')) return;
  try{
    const r = await fetch('/admin/agent/'+encodeURIComponent(slug)+'/delete?key='+encodeURIComponent(KEY),{method:'POST'});
    if(!r.ok){ alert('מחיקה נכשלה ('+r.status+')'); return; }
    load();
  }catch(e){ alert(e.message); }
}

function closeHist(){ q('#modal').classList.remove('open'); }

async function showHist(slug){
  try{
    const r = await fetch('/admin/agent/'+encodeURIComponent(slug)+'?key='+encodeURIComponent(KEY));
    if(!r.ok){ alert('טעינת היסטוריה נכשלה ('+r.status+')'); return; }
    const a = await r.json();
    const hist = a.usageHistory||[];
    const tot = a.usageTotals||{inTokens:0,outTokens:0,tokens:0,estCostUsd:0};
    const peak = Math.max(1, ...hist.map(h=>h.tokens));
    const rows = hist.length ? hist.map(h=>{
      const pct = Math.round(h.tokens/peak*100);
      return '<div class="hrow"><span class="d">'+h.day+'</span>'+
        '<span class="hbar"><i style="width:'+pct+'%"></i></span>'+
        '<span class="hcost">'+fmtUsd(h.estCostUsd)+'</span></div>'+
        '<div class="hrow" style="border:none;padding:0 0 4px"><span></span>'+
        '<span class="d" style="font-size:11px">in '+fmtNum(h.inTokens)+' · out '+fmtNum(h.outTokens)+'</span><span></span></div>';
    }).join('') : '<div class="empty">אין נתוני שימוש עדיין</div>';
    q('#sheet').innerHTML =
      '<button class="closex" onclick="closeHist()">×</button>'+
      '<h2>'+esc(a.friendlyName||a.slug)+'</h2>'+
      '<div class="slug sub">'+esc(a.slug)+' · '+esc(a.model||'—')+'</div>'+
      '<div class="totrow">'+
        '<div class="tot"><div class="v">'+fmtNum(tot.tokens)+'</div><div class="l">סך טוקנים</div></div>'+
        '<div class="tot"><div class="v">'+fmtUsd(tot.estCostUsd)+'</div><div class="l">עלות מצטברת</div></div>'+
        '<div class="tot"><div class="v">'+hist.length+'</div><div class="l">ימים עם שימוש</div></div>'+
      '</div>'+
      '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">לפי יום (UTC), 30 יום אחרונים</div>'+
      rows;
    q('#modal').classList.add('open');
  }catch(e){ alert(e.message); }
}

load();
</script>
</body>
</html>`;
}

// ─── router ──────────────────────────────────────────────────────────────────

/**
 * Handle any /admin* request. Always writes a response. Caller (webhook-server)
 * routes here for paths starting with /admin and returns afterward.
 */
export async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const u = new URL(req.url || '/', 'http://localhost');
  const pathname = u.pathname;
  const key = u.searchParams.get('key');

  if (!ADMIN_KEY) {
    sendJson(res, 503, { error: 'ADMIN_KEY not configured' });
    return;
  }
  if (!keyOk(key)) {
    // Generic 401 — no hint about what exists behind the key.
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized');
    return;
  }

  // GET /admin → HTML
  if (pathname === '/admin' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage(ADMIN_KEY));
    return;
  }

  // GET /admin/agents → list + kpis
  if (pathname === '/admin/agents' && req.method === 'GET') {
    const agents = buildAllAgents();
    sendJson(res, 200, { kpis: buildKpis(agents), agents });
    return;
  }

  // /admin/agent/:slug  and  /admin/agent/:slug/:action
  const m = pathname.match(/^\/admin\/agent\/([^/]+)(?:\/(pause|resume|delete))?$/);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    const action = m[2];
    const ag = getAgentGroupByFolder(slug);
    if (!ag || !slug.startsWith('pilot-')) {
      sendJson(res, 404, { error: 'agent not found' });
      return;
    }

    if (!action && req.method === 'GET') {
      // buildAgentView self-rolls the usage rollup, so history/totals are fresh.
      const view = buildAgentView(slug);
      // Map tiered costUsd → estCostUsd for the wire (frontend field name).
      const usageHistory = getUsageHistory(ag.id, 30).map((d: DayUsage) => ({
        day: d.day,
        inTokens: d.inTokens,
        outTokens: d.outTokens,
        tokens: d.tokens,
        estCostUsd: d.costUsd,
      }));
      const t = getUsageTotals(ag.id);
      const usageTotals = { inTokens: t.inTokens, outTokens: t.outTokens, tokens: t.tokens, estCostUsd: t.costUsd };
      sendJson(res, 200, { ...view, usageHistory, usageTotals });
      return;
    }
    if (action && req.method === 'POST') {
      try {
        if (action === 'pause') {
          sendJson(res, 200, { slug, ...pauseAgent(ag.id) });
          return;
        }
        if (action === 'resume') {
          sendJson(res, 200, { slug, ...resumeAgent(ag.id) });
          return;
        }
        if (action === 'delete') {
          // Optional belt-and-suspenders confirm flag; the UI double-confirms.
          await readBody(req).catch(() => '');
          const folder = ag.folder;
          const agentGroupId = ag.id;
          const result = deleteAgent(agentGroupId);
          const diskCleaned = cleanupAgentDisk(agentGroupId, folder);
          log.info('admin: agent deleted', { slug, agentGroupId, removed: result.removed, diskCleaned });
          sendJson(res, 200, { slug, ...result, diskCleaned });
          return;
        }
      } catch (err) {
        log.error('admin: action failed', { slug, action, err });
        sendJson(res, 500, { error: 'action failed' });
        return;
      }
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
