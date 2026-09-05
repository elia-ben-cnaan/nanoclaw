/**
 * Users Board — data layer.
 *
 * Personal action board for the pilot operator: "who do I act on right now,
 * and why". Built on TWO sources of truth only:
 *
 *   1. Signup + identity  → pilot_activations (joined via agent_group_id)
 *                           + agent_groups.created_at.
 *   2. Behavior/retention → messages_in rows with kind='chat-sdk' from each
 *                           pilot's inbound.db. These are REAL user messages.
 *
 * Explicitly NOT a source: sessions.last_active — it is bumped by scheduled /
 * agent-initiated traffic, so it lies about user engagement.
 *
 * outbound.db is consulted for ONE thing only: whether the agent's last reply
 * predates the user's last message (open/unanswered signal). It never feeds
 * retention or scoring.
 *
 * All scoring functions are pure and exported for tests.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { getDb } from './db/connection.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import { getActivationByAgentGroup } from './modules/pilot-activation/db.js';
import { log } from './log.js';

/**
 * Signup-form identity from the activation that created the pilot
 * (pilot_activations.metadata, set at /provision time). Same parse as
 * admin-dashboard's readRegistrationInfo — duplicated here (3 fields) to
 * keep the module graph acyclic: admin-dashboard imports this module for
 * the board routes.
 */
function readRegistrationInfo(agentGroupId: string): { userName: string | null; source: string | null } {
  try {
    const activation = getActivationByAgentGroup(agentGroupId);
    const meta = activation?.metadata ? (JSON.parse(activation.metadata) as Record<string, unknown>) : null;
    const name = typeof meta?.name === 'string' ? meta.name.trim() : '';
    const src = typeof meta?.src === 'string' ? meta.src.trim() : '';
    return { userName: name || null, source: src || null };
  } catch {
    return { userName: null, source: null };
  }
}

// ─── raw activity collection ─────────────────────────────────────────────────

export interface UserActivity {
  /** Count of real user messages (kind='chat-sdk') across all sessions. */
  count: number;
  /** Epoch ms of first / last user message. null when count = 0. */
  firstMs: number | null;
  lastMs: number | null;
  /** Distinct local calendar days (YYYY-MM-DD in TIMEZONE) with a user message. */
  activeDays: string[];
  /** User messages in the trailing 7 days / the 7 days before those. */
  last7: number;
  prev7: number;
  /** Text of the last user message (trimmed), for card context. */
  lastText: string | null;
  /** True when the agent's last reply is OLDER than the user's last message —
   *  i.e. the user is waiting on us (or the agent silently dropped a turn). */
  awaitingReply: boolean;
}

/**
 * messages_in.timestamp is host-written ISO (with Z); messages_out.timestamp
 * is SQLite datetime('now') without a zone marker. Same normalization as
 * admin-dashboard's parseTimestampMs.
 */
export function parseTsMs(ts: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts + 'Z');
}

/**
 * The board is fixed to Israel local time regardless of the global TZ config
 * (which is UTC for scheduling — see config.ts). "Active today" and every
 * day-boundary on this board should match the operator's own clock, not the
 * host's. Asia/Jerusalem (not a fixed UTC+3 offset) so DST transitions stay
 * correct automatically.
 */
export const BOARD_TIMEZONE = 'Asia/Jerusalem';

export function localDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: BOARD_TIMEZONE });
}

function extractText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text.trim();
  } catch {
    /* non-JSON content — ignore */
  }
  return null;
}

/** Fold a list of (ms, text) user-message rows into a UserActivity. Pure. */
export function summarizeActivity(
  rows: Array<{ ms: number; text: string | null }>,
  lastAgentReplyMs: number | null,
  nowMs: number,
): UserActivity {
  const valid = rows.filter((r) => Number.isFinite(r.ms)).sort((a, b) => a.ms - b.ms);
  if (valid.length === 0) {
    return {
      count: 0,
      firstMs: null,
      lastMs: null,
      activeDays: [],
      last7: 0,
      prev7: 0,
      lastText: null,
      awaitingReply: false,
    };
  }
  const days = new Set<string>();
  let last7 = 0;
  let prev7 = 0;
  const DAY = 24 * 60 * 60 * 1000;
  for (const r of valid) {
    days.add(localDay(r.ms));
    const age = nowMs - r.ms;
    if (age <= 7 * DAY) last7++;
    else if (age <= 14 * DAY) prev7++;
  }
  const last = valid[valid.length - 1];
  return {
    count: valid.length,
    firstMs: valid[0].ms,
    lastMs: last.ms,
    activeDays: [...days].sort(),
    last7,
    prev7,
    lastText: last.text,
    awaitingReply: lastAgentReplyMs !== null ? lastAgentReplyMs < last.ms : false,
  };
}

/** Read all chat-sdk inbound rows for one pilot (all its sessions). */
function collectActivity(agentGroupId: string, nowMs: number): UserActivity {
  const rows: Array<{ ms: number; text: string | null }> = [];
  let lastAgentReplyMs: number | null = null;
  for (const sess of getSessionsByAgentGroup(agentGroupId)) {
    const inP = inboundDbPath(agentGroupId, sess.id);
    if (fs.existsSync(inP)) {
      try {
        const d = new Database(inP, { readonly: true });
        try {
          const rs = d.prepare("SELECT timestamp, content FROM messages_in WHERE kind = 'chat-sdk'").all() as Array<{
            timestamp: string;
            content: string;
          }>;
          for (const r of rs) rows.push({ ms: parseTsMs(r.timestamp), text: extractText(r.content) });
        } finally {
          d.close();
        }
      } catch (err) {
        log.warn('users-board: inbound read failed', { agentGroupId, sessionId: sess.id, err });
      }
    }
    const outP = outboundDbPath(agentGroupId, sess.id);
    if (fs.existsSync(outP)) {
      try {
        const d = new Database(outP, { readonly: true });
        try {
          const r = d.prepare('SELECT MAX(timestamp) AS t FROM messages_out').get() as { t: string | null };
          if (r.t) {
            const ms = parseTsMs(r.t);
            if (lastAgentReplyMs === null || ms > lastAgentReplyMs) lastAgentReplyMs = ms;
          }
        } finally {
          d.close();
        }
      } catch (err) {
        log.warn('users-board: outbound read failed', { agentGroupId, sessionId: sess.id, err });
      }
    }
  }
  return summarizeActivity(rows, lastAgentReplyMs, nowMs);
}

// ─── full transcript (for the qualitative detail view) ──────────────────────

export interface TranscriptMessage {
  role: 'user' | 'agent';
  text: string;
  ms: number;
}

export interface DayTranscript {
  day: string;
  messages: TranscriptMessage[];
}

/**
 * Full per-day transcript for one pilot: every real user message
 * (kind='chat-sdk') interleaved with every agent reply, grouped by local
 * calendar day and sorted chronologically within the day. This is the
 * source for the qualitative layer — quotes, per-day summaries, and the
 * LLM prompt — as distinct from collectActivity() above, which only keeps
 * aggregate counts + the single last message for scoring.
 */
export function collectDailyTranscript(agentGroupId: string): DayTranscript[] {
  const byDay = new Map<string, TranscriptMessage[]>();
  const push = (ms: number, role: 'user' | 'agent', text: string | null): void => {
    if (!text || !Number.isFinite(ms)) return;
    const day = localDay(ms);
    const arr = byDay.get(day) ?? [];
    arr.push({ role, text, ms });
    byDay.set(day, arr);
  };

  for (const sess of getSessionsByAgentGroup(agentGroupId)) {
    const inP = inboundDbPath(agentGroupId, sess.id);
    if (fs.existsSync(inP)) {
      try {
        const d = new Database(inP, { readonly: true });
        try {
          const rs = d.prepare("SELECT timestamp, content FROM messages_in WHERE kind = 'chat-sdk'").all() as Array<{
            timestamp: string;
            content: string;
          }>;
          for (const r of rs) push(parseTsMs(r.timestamp), 'user', extractText(r.content));
        } finally {
          d.close();
        }
      } catch (err) {
        log.warn('users-board: transcript inbound read failed', { agentGroupId, sessionId: sess.id, err });
      }
    }
    const outP = outboundDbPath(agentGroupId, sess.id);
    if (fs.existsSync(outP)) {
      try {
        const d = new Database(outP, { readonly: true });
        try {
          const rs = d.prepare('SELECT timestamp, content FROM messages_out').all() as Array<{
            timestamp: string;
            content: string;
          }>;
          for (const r of rs) push(parseTsMs(r.timestamp), 'agent', extractText(r.content));
        } finally {
          d.close();
        }
      } catch (err) {
        log.warn('users-board: transcript outbound read failed', { agentGroupId, sessionId: sess.id, err });
      }
    }
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, messages]) => ({ day, messages: messages.sort((a, b) => a.ms - b.ms) }));
}

// ─── scoring (pure) ──────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

/**
 * Churn risk 0–100. Transparent heuristic, tuned for tiny personal cohorts:
 *
 *   never talked   → 45 while fresh (< 2 days), then 90.
 *   otherwise      → silence gap relative to the user's own cadence:
 *                    0 at ≤1 day of silence, 100 at ≥ max(5, 3×typical-gap)
 *                    days, linear in between; +15 when weekly volume halved
 *                    (trend), capped at 100.
 *
 * "typical gap" = tenure-days / active-days — how often this user shows up
 * when they're alive. A daily user going quiet for 4 days is at risk; a
 * once-a-week user isn't.
 */
export function churnRisk(signupMs: number, activity: UserActivity, nowMs: number): number {
  if (activity.count === 0 || activity.lastMs === null || activity.firstMs === null) {
    return nowMs - signupMs < 2 * DAY ? 45 : 90;
  }
  const gapDays = (nowMs - activity.lastMs) / DAY;
  if (gapDays <= 1) {
    return activity.last7 > 0 && activity.prev7 >= 2 * activity.last7 && activity.prev7 >= 4 ? 30 : 5;
  }
  const tenureDays = Math.max(1, (nowMs - activity.firstMs) / DAY);
  const typicalGap = Math.max(1, tenureDays / Math.max(1, activity.activeDays.length));
  const ceiling = Math.max(5, 3 * typicalGap);
  let risk = Math.round(Math.min(1, gapDays / ceiling) * 100);
  if (activity.prev7 >= 4 && activity.last7 <= activity.prev7 / 2) risk += 15;
  return Math.max(0, Math.min(100, risk));
}

/**
 * Referral moment: engaged (≥4 active days, ≥15 messages), tenured (≥5 days
 * since first message), and currently healthy (risk ≤ 25).
 */
export function referralReady(activity: UserActivity, risk: number, nowMs: number): boolean {
  if (activity.firstMs === null) return false;
  const tenureDays = (nowMs - activity.firstMs) / DAY;
  return risk <= 25 && activity.activeDays.length >= 4 && activity.count >= 15 && tenureDays >= 5;
}

export type ActionType = 'referral' | 'reengage' | 'activate' | 'unstick' | 'none';

/**
 * Distill the raw last user message into one clean line for the card:
 * collapse whitespace, take the first clause (up to sentence punctuation /
 * newline / colon), and cap at a word boundary. Deterministic — no model in
 * the loop, so it's the user's own words, just trimmed to the gist.
 */
export function distillLastText(text: string | null, maxLen = 60): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const clauseMatch = flat.match(/^[^.!?\n:]{3,}?(?=[.!?\n:]|$)/);
  let clause = (clauseMatch ? clauseMatch[0] : flat).trim();
  if (clause.length < 10 && flat.length > clause.length) clause = flat; // ":" too early — keep more
  if (clause.length <= maxLen) return clause;
  const cut = clause.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen / 2 ? cut.slice(0, lastSpace) : cut) + '…';
}

export interface SuggestedAction {
  type: ActionType;
  /** Ready-to-send Hebrew text, personalized when a name exists. */
  text: string | null;
  /** One-line operator-facing reason. */
  why: string;
}

export function suggestAction(
  name: string | null,
  activity: UserActivity,
  risk: number,
  isReferralReady: boolean,
  nowMs: number,
): SuggestedAction {
  const first = name ? name.split(/\s+/)[0] : null;
  const hi = first ? `היי ${first}` : 'היי';
  if (activity.awaitingReply) {
    return {
      type: 'unstick',
      text: null,
      why: 'המשתמש כתב אחרי התשובה האחרונה של הסוכן — לבדוק שהסוכן ענה',
    };
  }
  if (isReferralReady) {
    return {
      type: 'referral',
      text: `${hi}, שמח לראות שאתם עובדים יחד יפה! אם יש מישהו שהיה נהנה מסוכן כזה בדיוק כמוך — אשמח אם תשתף/י אותו, זה עוזר לנו מאוד 🙏`,
      why: 'משתמש מרוצה ופעיל — רגע טוב לבקש הפניה',
    };
  }
  if (activity.count === 0) {
    const daysSince = Math.floor((nowMs - (activity.firstMs ?? nowMs)) / DAY);
    return {
      type: 'activate',
      text: `${hi}, ראיתי שנרשמת ועוד לא יצא לכם לדבר — יש משהו שאפשר לעזור בו כדי להתחיל? אפשר פשוט לכתוב לסוכן מה שהיית שואל/ת עוזר אישי`,
      why: daysSince >= 2 ? 'נרשם ולא שלח אף הודעה' : 'נרשם טרי — עדיין לא דיבר',
    };
  }
  if (risk >= 60) {
    const gapDays = activity.lastMs ? Math.floor((nowMs - activity.lastMs) / DAY) : null;
    return {
      type: 'reengage',
      text: `${hi}, לא שמעתי ממך כבר כמה ימים — הכל בסדר עם הסוכן? אם משהו הפריע או חסר, אשמח לשמוע ולתקן`,
      why: gapDays !== null ? `שקט ${gapDays} ימים, מעל הקצב הרגיל שלו` : 'סיכון נטישה גבוה',
    };
  }
  return { type: 'none', text: null, why: 'יציב — אין פעולה נדרשת' };
}

// ─── retention rollup (pure) ─────────────────────────────────────────────────

/**
 * Dn retained = among users whose signup is ≥ n days old, the share that sent
 * a real message on calendar day signup+n OR LATER ("still around at day n").
 * Cumulative rather than exact-day — with cohorts this small, exact-day Dn is
 * all noise.
 */
export function retentionAtDay(
  users: Array<{ signupMs: number; lastMs: number | null }>,
  n: number,
  nowMs: number,
): {
  eligible: number;
  retained: number;
  pct: number | null;
} {
  const eligibleUsers = users.filter((u) => nowMs - u.signupMs >= n * DAY);
  const retained = eligibleUsers.filter((u) => u.lastMs !== null && u.lastMs - u.signupMs >= n * DAY).length;
  return {
    eligible: eligibleUsers.length,
    retained,
    pct: eligibleUsers.length > 0 ? Math.round((retained / eligibleUsers.length) * 100) : null,
  };
}

// ─── board assembly ──────────────────────────────────────────────────────────

export type BoardGroup = 'attention' | 'referral' | 'stable';

export interface BoardUser {
  slug: string;
  agentGroupId: string;
  name: string | null;
  source: string | null;
  signupAt: string;
  tenureDays: number;
  messageCount: number;
  activeDays: number;
  lastMessageAt: string | null;
  lastMessageDaysAgo: number | null;
  lastText: string | null;
  /** One-line distilled gist of the last message (see distillLastText). */
  lastGist: string | null;
  last7: number;
  prev7: number;
  churnRisk: number;
  referralReady: boolean;
  awaitingReply: boolean;
  group: BoardGroup;
  action: SuggestedAction;
  /** One factual sentence describing where this user stands. */
  story: string;
}

/** A signup that never became a live pilot (pending activation). */
export interface SignupRow {
  name: string | null;
  phone: string | null;
  source: string | null;
  createdAt: string;
  daysAgo: number;
}

/** A consumed activation whose pilot is broken or gone. */
export interface ProvisioningIssue {
  name: string | null;
  kind: 'stuck' | 'deleted';
  usedAt: string | null;
}

export interface BoardRollup {
  totalUsers: number;
  /** Full funnel: every pilot_activations row accounted for. */
  totalActivations: number;
  pendingSignups: number;
  provisioningStuck: number;
  deletedPilots: number;
  signupsBySource: Array<{ source: string; count: number }>;
  retention: {
    d1: ReturnType<typeof retentionAtDay>;
    d3: ReturnType<typeof retentionAtDay>;
    d7: ReturnType<typeof retentionAtDay>;
  };
  activeToday: number;
  needsAttention: number;
  referralReady: number;
  neverTalkedPct: number | null;
  /** Aggregate drop-off insights to feed back into the pilot template. */
  templateFeedback: string[];
}

export interface UsersBoard {
  generatedAt: string;
  rollup: BoardRollup;
  users: BoardUser[];
  signups: SignupRow[];
  issues: ProvisioningIssue[];
}

/**
 * Account for every pilot_activations row that is NOT a live pilot:
 *   pending  → signed the form, never completed activation. Deduped by phone
 *              (falling back to name+day) — repeat form submissions are one
 *              person. Signups whose phone later shows up in a used
 *              activation are dropped (they DID become users).
 *   used but group missing/never-created → provisioning issue (stuck/deleted).
 */
function collectNonUserActivations(liveGroupIds: Set<string>): {
  signups: SignupRow[];
  issues: ProvisioningIssue[];
  totalActivations: number;
} {
  const rows = getDb()
    .prepare(`SELECT code, status, metadata, created_at, used_at, agent_group_id FROM pilot_activations`)
    .all() as Array<{
    code: string;
    status: string;
    metadata: string | null;
    created_at: string;
    used_at: string | null;
    agent_group_id: string | null;
  }>;

  const parseMeta = (m: string | null): { name: string | null; phone: string | null; src: string | null } => {
    try {
      const meta = m ? (JSON.parse(m) as Record<string, unknown>) : null;
      const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
      return { name: s(meta?.name), phone: s(meta?.phone), src: s(meta?.src) };
    } catch {
      return { name: null, phone: null, src: null };
    }
  };

  const usedPhones = new Set<string>();
  for (const r of rows) {
    if (r.status === 'used') {
      const p = parseMeta(r.metadata).phone;
      if (p) usedPhones.add(p);
    }
  }

  const nowMs = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const signupByKey = new Map<string, SignupRow>();
  const issues: ProvisioningIssue[] = [];

  for (const r of rows) {
    const meta = parseMeta(r.metadata);
    if (r.status === 'used') {
      if (r.agent_group_id && liveGroupIds.has(r.agent_group_id)) continue; // live pilot — on the board
      issues.push({
        name: meta.name,
        kind: r.agent_group_id?.startsWith('pending-') ? 'stuck' : 'deleted',
        usedAt: r.used_at,
      });
      continue;
    }
    // pending: one row per person, newest submission wins
    if (meta.phone && usedPhones.has(meta.phone)) continue;
    const key = meta.phone ?? `${meta.name ?? r.code}|${r.created_at.slice(0, 10)}`;
    const existing = signupByKey.get(key);
    if (!existing || existing.createdAt < r.created_at) {
      signupByKey.set(key, {
        name: meta.name,
        phone: meta.phone,
        source: meta.src,
        createdAt: r.created_at,
        daysAgo: Math.floor((nowMs - parseTsMs(r.created_at)) / DAY_MS),
      });
    }
  }

  const signups = [...signupByKey.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { signups, issues, totalActivations: rows.length };
}

function classify(risk: number, refReady: boolean, awaitingReply: boolean): BoardGroup {
  if (awaitingReply || risk >= 60) return 'attention';
  if (refReady) return 'referral';
  return 'stable';
}

export function buildStory(name: string | null, activity: UserActivity, nowMs: number, signupMs: number): string {
  const who = name ? name.split(/\s+/)[0] : 'המשתמש';
  if (activity.count === 0) {
    const d = Math.floor((nowMs - signupMs) / DAY);
    return d <= 1 ? `${who} נרשם היום ועוד לא שלח הודעה.` : `${who} נרשם לפני ${d} ימים ולא שלח אף הודעה.`;
  }
  const gap = activity.lastMs ? Math.floor((nowMs - activity.lastMs) / DAY) : 0;
  const vol = `${activity.count} הודעות על פני ${activity.activeDays.length} ימים`;
  if (activity.awaitingReply) return `${who} כתב ${gap === 0 ? 'היום' : `לפני ${gap} ימים`} ולא קיבל מענה (${vol}).`;
  if (gap === 0) return `${who} פעיל היום (${vol}).`;
  if (gap === 1) return `${who} דיבר אתמול לאחרונה (${vol}).`;
  return `${who} שקט ${gap} ימים (${vol}).`;
}

/**
 * Build the full board. Reads central DB + every pilot's session DBs
 * (readonly). `nowMs` injectable for tests.
 */
export function buildUsersBoard(nowMs: number = Date.now()): UsersBoard {
  const groups = getDb()
    .prepare(
      `SELECT id, folder, created_at FROM agent_groups
       WHERE folder LIKE 'pilot-%' OR folder LIKE 'whatsapp-%'
       ORDER BY created_at DESC`,
    )
    .all() as Array<{ id: string; folder: string; created_at: string }>;

  const users: BoardUser[] = [];
  for (const g of groups) {
    const reg = readRegistrationInfo(g.id);
    const activity = collectActivity(g.id, nowMs);
    const signupMs = parseTsMs(g.created_at);
    const risk = churnRisk(signupMs, activity, nowMs);
    const refReady = referralReady(activity, risk, nowMs);
    const action = suggestAction(reg.userName, activity, risk, refReady, nowMs);
    users.push({
      slug: g.folder,
      agentGroupId: g.id,
      name: reg.userName,
      source: reg.source,
      signupAt: g.created_at,
      tenureDays: Math.floor((nowMs - signupMs) / DAY),
      messageCount: activity.count,
      activeDays: activity.activeDays.length,
      lastMessageAt: activity.lastMs ? new Date(activity.lastMs).toISOString() : null,
      lastMessageDaysAgo: activity.lastMs ? Math.floor((nowMs - activity.lastMs) / DAY) : null,
      lastText: activity.lastText,
      lastGist: distillLastText(activity.lastText),
      last7: activity.last7,
      prev7: activity.prev7,
      churnRisk: risk,
      referralReady: refReady,
      awaitingReply: activity.awaitingReply,
      group: classify(risk, refReady, activity.awaitingReply),
      action,
      story: buildStory(reg.userName, activity, nowMs, signupMs),
    });
  }

  // Sort inside groups: attention by risk desc, referral by activity, stable by recency.
  const order: Record<BoardGroup, number> = { attention: 0, referral: 1, stable: 2 };
  users.sort((a, b) => {
    if (order[a.group] !== order[b.group]) return order[a.group] - order[b.group];
    if (a.group === 'attention') return b.churnRisk - a.churnRisk;
    if (a.group === 'referral') return b.messageCount - a.messageCount;
    return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
  });

  // Rollup
  const bySource = new Map<string, number>();
  for (const u of users) {
    const s = u.source || 'לא מסומן';
    bySource.set(s, (bySource.get(s) ?? 0) + 1);
  }
  const retentionInput = users.map((u) => ({
    signupMs: parseTsMs(u.signupAt),
    lastMs: u.lastMessageAt ? parseTsMs(u.lastMessageAt) : null,
  }));
  const todayKey = localDay(nowMs);
  const neverTalked = users.filter((u) => u.messageCount === 0).length;

  const templateFeedback: string[] = [];
  if (users.length >= 3) {
    const neverPct = Math.round((neverTalked / users.length) * 100);
    if (neverPct >= 30) {
      templateFeedback.push(`${neverPct}% מהנרשמים לא שלחו אף הודעה — לחזק את פתיח השיחה / ההנחיה הראשונה בתבנית.`);
    }
    const talkedOnceOnly = users.filter((u) => u.messageCount > 0 && u.activeDays <= 1 && u.tenureDays >= 2).length;
    const talkers = users.filter((u) => u.messageCount > 0).length;
    if (talkers >= 3) {
      const oncePct = Math.round((talkedOnceOnly / talkers) * 100);
      if (oncePct >= 40) {
        templateFeedback.push(
          `${oncePct}% ממי שדיברו נעצרו ביום הראשון — לתת לסוכן סיבת-חזרה (מעקב יזום, תזכורת ערך) בתבנית.`,
        );
      }
    }
    const stuck = users.filter((u) => u.awaitingReply).length;
    if (stuck > 0) {
      templateFeedback.push(`${stuck} משתמשים ממתינים כרגע לתשובה — לבדוק תקינות לפני כל דבר אחר.`);
    }
  }

  const nonUsers = collectNonUserActivations(new Set(groups.map((g) => g.id)));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    rollup: {
      totalUsers: users.length,
      totalActivations: nonUsers.totalActivations,
      pendingSignups: nonUsers.signups.length,
      provisioningStuck: nonUsers.issues.filter((i) => i.kind === 'stuck').length,
      deletedPilots: nonUsers.issues.filter((i) => i.kind === 'deleted').length,
      signupsBySource: [...bySource.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      retention: {
        d1: retentionAtDay(retentionInput, 1, nowMs),
        d3: retentionAtDay(retentionInput, 3, nowMs),
        d7: retentionAtDay(retentionInput, 7, nowMs),
      },
      activeToday: users.filter((u) => u.lastMessageAt && localDay(parseTsMs(u.lastMessageAt)) === todayKey).length,
      needsAttention: users.filter((u) => u.group === 'attention').length,
      referralReady: users.filter((u) => u.group === 'referral').length,
      neverTalkedPct: users.length > 0 ? Math.round((neverTalked / users.length) * 100) : null,
      templateFeedback,
    },
    users,
    signups: nonUsers.signups,
    issues: nonUsers.issues,
  };
}
