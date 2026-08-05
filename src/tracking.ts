/**
 * Anonymous landing-funnel tracking store — replaces the Vercel Blob backend
 * that /api/ta (write) + /api/app-summary (read) used to hit, which is halted
 * while the team's Blob storage is suspended. Vercel functions can't receive
 * injected credentials, so the store moves here, onto the VM, behind the same
 * :3000 webhook server the operator dashboard already runs on.
 *
 * Two endpoints, wired in webhook-server.ts:
 *   POST /track        — open, CORS-open, no auth. Cross-origin beacon from the
 *                        landing pages (shellano.com / click2agent.com) via
 *                        navigator.sendBeacon. Appends one row per call. ALWAYS
 *                        200, even on bad input — a beacon must never see an
 *                        error, or the browser retries/logs noise.
 *   GET  /app/summary  — gated exactly like /admin/agents (ADMIN_KEY via ?key=
 *                        or x-admin-key header). Folds all rows into one journey
 *                        per visitor (vid) and returns the funnel shape the
 *                        dashboard already expects.
 *
 * Storage: a dedicated SQLite file (data/tracking.db, WAL). Separate from the
 * central v2.db so high-volume append traffic never contends with the host's
 * routing writes. On-disk => survives restart. One prepared INSERT per beacon
 * => cheap.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';

import { adminKeyOk, isAdminKeyConfigured } from './admin-dashboard.js';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

// ─── field caps ──────────────────────────────────────────────────────────────
// Mandated by the spec: src → 64, ua → 300, events → 90 items. The rest are
// capped generously as a cheap abuse backstop (an open beacon endpoint).
const SRC_MAX = 64;
const UA_MAX = 300;
const EVENTS_MAX = 90;
const VID_MAX = 128;
const PAGE_MAX = 512;
const REFERRER_MAX = 1024;
const LANG_MAX = 32;
const TS_MAX = 40;
const TYPE_MAX = 16;
/** Reject absurd bodies before parsing — a real beacon is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;

// ─── record shape (one DB row) ────────────────────────────────────────────────

export interface TrackRecord {
  received_at: string;
  type: string;
  vid: string;
  page: string;
  src: string;
  lang: string;
  referrer: string;
  ua: string;
  ts: string;
  dwell_ms: number;
  max_step: number;
  max_scroll: number;
  submitted: number; // 0 | 1
  events: string; // JSON array of event-name strings, e.g. ["cta_click","reached_form"]
}

// ─── coercion helpers (never throw) ────────────────────────────────────────────

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true';
}

/**
 * Extract event names from the incoming `events` field. Accepts the wire shape
 * ([{ e: "cta_click" }, ...]) or a plain string array; anything else yields no
 * names. Truncated to EVENTS_MAX items.
 */
function eventNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const names: string[] = [];
  for (const it of v) {
    if (names.length >= EVENTS_MAX) break;
    if (it && typeof it === 'object' && typeof (it as { e?: unknown }).e === 'string') {
      names.push((it as { e: string }).e);
    } else if (typeof it === 'string') {
      names.push(it);
    }
  }
  return names;
}

/** Parse the stored `events` column (JSON string) back to a name array. Also
 *  tolerates an already-parsed array, so the fold logic is testable without a DB. */
function parseEventNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Normalize a raw beacon body into a storable row. Never throws. */
export function normalizeIncoming(raw: unknown, nowIso: string): TrackRecord {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    received_at: nowIso,
    type: str(o.type, TYPE_MAX),
    vid: str(o.vid, VID_MAX),
    page: str(o.page, PAGE_MAX),
    src: str(o.src, SRC_MAX),
    lang: str(o.lang, LANG_MAX),
    referrer: str(o.referrer, REFERRER_MAX),
    ua: str(o.ua, UA_MAX),
    ts: str(o.ts, TS_MAX),
    dwell_ms: toInt(o.dwell_ms),
    max_step: toInt(o.max_step),
    max_scroll: toInt(o.max_scroll),
    submitted: toBool(o.submitted) ? 1 : 0,
    events: JSON.stringify(eventNames(o.events)),
  };
}

// ─── storage ───────────────────────────────────────────────────────────────────

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      type TEXT, vid TEXT, page TEXT, src TEXT, lang TEXT, referrer TEXT, ua TEXT, ts TEXT,
      dwell_ms INTEGER, max_step INTEGER, max_scroll INTEGER, submitted INTEGER, events TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_track_events_vid ON track_events(vid);
  `);
}

const INSERT_SQL = `INSERT INTO track_events
  (received_at, type, vid, page, src, lang, referrer, ua, ts, dwell_ms, max_step, max_scroll, submitted, events)
  VALUES (@received_at, @type, @vid, @page, @src, @lang, @referrer, @ua, @ts, @dwell_ms, @max_step, @max_scroll, @submitted, @events)`;

export function insertRecord(db: Database.Database, rec: TrackRecord): void {
  db.prepare(INSERT_SQL).run(rec);
}

/** Only the columns the fold needs — keeps the read light as the table grows. */
export interface StoredRow {
  vid: string;
  src: string;
  max_step: number;
  dwell_ms: number;
  submitted: number;
  events: string;
  received_at: string;
  type: string;
}

export function selectRows(db: Database.Database): StoredRow[] {
  return db
    .prepare(
      'SELECT vid, src, max_step, dwell_ms, submitted, events, received_at, type FROM track_events ORDER BY id ASC',
    )
    .all() as StoredRow[];
}

// Lazily-opened singleton for the default on-disk store. Overridable via env for
// tests / alternate deployments.
let _db: Database.Database | null = null;

function trackDb(): Database.Database {
  if (_db) return _db;
  const p = process.env.NANOCLAW_TRACKING_DB || path.join(DATA_DIR, 'tracking.db');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  _db = new Database(p);
  _db.pragma('journal_mode = WAL');
  ensureSchema(_db);
  log.info('Tracking store opened', { path: p });
  return _db;
}

// ─── folding ───────────────────────────────────────────────────────────────────

export interface Journey {
  vid: string;
  src: string; // first non-empty src seen for this visitor ('' if never set)
  maxStep: number;
  dwell: number;
  clicked: boolean;
  reachedForm: boolean;
  submitted: boolean;
  firstAt: string | null; // earliest received_at (server UTC) seen for this visitor
  lastAt: string | null; // latest received_at (server UTC) seen for this visitor
}

/**
 * Collapse rows into one journey per visitor (vid), applying the spec's rules:
 *   src         = first non-empty src
 *   maxStep     = max(max_step)
 *   dwell       = max(dwell_ms)
 *   clicked     = event 'cta_click'      OR maxStep >= 1
 *   reachedForm = event 'reached_form'   OR maxStep >= 4
 *   submitted   = submitted flag         OR event 'register_submit'
 */
export function foldJourneys(rows: Array<Partial<StoredRow>>): Journey[] {
  interface Acc {
    vid: string;
    src: string;
    maxStep: number;
    dwell: number;
    clickedEv: boolean;
    reachedFormEv: boolean;
    submitted: boolean;
    firstMs: number;
    firstAt: string | null;
    lastMs: number;
    lastAt: string | null;
  }
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const vid = typeof r.vid === 'string' ? r.vid : String(r.vid ?? '');
    let a = map.get(vid);
    if (!a) {
      a = {
        vid,
        src: '',
        maxStep: 0,
        dwell: 0,
        clickedEv: false,
        reachedFormEv: false,
        submitted: false,
        firstMs: Infinity,
        firstAt: null,
        lastMs: -Infinity,
        lastAt: null,
      };
      map.set(vid, a);
    }
    const src = typeof r.src === 'string' ? r.src : '';
    if (!a.src && src) a.src = src;
    const ms = toInt(r.max_step);
    if (ms > a.maxStep) a.maxStep = ms;
    const dw = toInt(r.dwell_ms);
    if (dw > a.dwell) a.dwell = dw;
    // Track first/last activity on received_at, the trusted server-side UTC
    // receipt stamp (never the client's ts). Rows with an unparseable stamp
    // don't move the window.
    const ra = typeof r.received_at === 'string' ? r.received_at : '';
    const raMs = Date.parse(ra);
    if (Number.isFinite(raMs)) {
      if (raMs < a.firstMs) {
        a.firstMs = raMs;
        a.firstAt = ra;
      }
      if (raMs > a.lastMs) {
        a.lastMs = raMs;
        a.lastAt = ra;
      }
    }
    const names = parseEventNames(r.events);
    if (names.includes('cta_click')) a.clickedEv = true;
    if (names.includes('reached_form')) a.reachedFormEv = true;
    if (toBool(r.submitted) || names.includes('register_submit')) a.submitted = true;
  }
  return [...map.values()].map((a) => ({
    vid: a.vid,
    src: a.src,
    maxStep: a.maxStep,
    dwell: a.dwell,
    clicked: a.clickedEv || a.maxStep >= 1,
    reachedForm: a.reachedFormEv || a.maxStep >= 4,
    submitted: a.submitted,
    firstAt: a.firstAt,
    lastAt: a.lastAt,
  }));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface WindowTotals {
  visits: number;
  unique_visitors: number;
}

export interface FunnelSummary {
  ok: true;
  funnel: {
    entered: number;
    clicked: number;
    reachedForm: number;
    submitted: number;
    droppedNoForm: number;
    abandonedForm: number;
  };
  /**
   * Explicit traffic totals, separate from the folded funnel. `total_visits`
   * counts visit beacons (one per page load); `unique_visitors` counts distinct
   * vids — the same population as funnel.entered. Time windows are cut on
   * received_at, the server-side UTC receipt stamp (never the client's ts,
   * which is untrusted and may carry a wrong clock/timezone).
   */
  totals: {
    total_visits: number;
    unique_visitors: number;
    last_24h: WindowTotals;
    last_7d: WindowTotals;
  };
  depth: [number, number, number, number, number];
  medDwellMs: number;
  bySource: Array<{
    label: string;
    entered: number;
    reachedForm: number;
    submitted: number;
    firstAt: string | null; // earliest entry across this source's visitors (server UTC), null if unknown
    lastAt: string | null; // latest entry across this source's visitors (server UTC), null if unknown
  }>;
  generated_at: string;
}

const H24_MS = 24 * 60 * 60 * 1000;
const D7_MS = 7 * H24_MS;

/**
 * A row counts as one visit when the tracker flagged it type='visit' (one per
 * page load). Legacy rows written before the type field existed have type=''
 * — those predate the visit/session split and are excluded from visit counts
 * (they still feed the funnel fold).
 */
function isVisit(r: Partial<StoredRow>): boolean {
  return r.type === 'visit';
}

/**
 * Two visit beacons from the same vid inside this window collapse to one
 * visit — absorbs quick reloads and browser double-fires, and matches the
 * conventional 30-minute session definition. rows arrive ordered by id, so
 * tracking the last counted time per vid is enough.
 */
const VISIT_DEDUP_MS = 30 * 60 * 1000;

function buildTotals(rows: Array<Partial<StoredRow>>, nowIso: string): FunnelSummary['totals'] {
  const nowMs = Date.parse(nowIso);
  const empty = (): { visits: number; vids: Set<string> } => ({ visits: 0, vids: new Set() });
  const all = empty();
  const h24 = empty();
  const d7 = empty();
  const lastVisitAt = new Map<string, number>();
  for (const r of rows) {
    const vid = typeof r.vid === 'string' ? r.vid : String(r.vid ?? '');
    const t = Date.parse(typeof r.received_at === 'string' ? r.received_at : '');
    let visit = isVisit(r);
    if (visit && Number.isFinite(t)) {
      const prev = lastVisitAt.get(vid);
      if (prev !== undefined && t - prev < VISIT_DEDUP_MS) visit = false;
      else lastVisitAt.set(vid, t);
    }
    all.vids.add(vid);
    if (visit) all.visits++;
    if (!Number.isFinite(t) || !Number.isFinite(nowMs)) continue;
    const age = nowMs - t;
    if (age <= H24_MS) {
      h24.vids.add(vid);
      if (visit) h24.visits++;
    }
    if (age <= D7_MS) {
      d7.vids.add(vid);
      if (visit) d7.visits++;
    }
  }
  return {
    total_visits: all.visits,
    unique_visitors: all.vids.size,
    last_24h: { visits: h24.visits, unique_visitors: h24.vids.size },
    last_7d: { visits: d7.visits, unique_visitors: d7.vids.size },
  };
}

/** Build the exact structure the dashboard consumes from the raw rows. */
export function buildSummary(rows: Array<Partial<StoredRow>>, nowIso: string): FunnelSummary {
  const journeys = foldJourneys(rows);

  let clicked = 0;
  let reachedForm = 0;
  let submitted = 0;
  const depth: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const dwells: number[] = [];
  const bySrc = new Map<
    string,
    { label: string; entered: number; reachedForm: number; submitted: number; firstAt: string | null; lastAt: string | null }
  >();

  for (const j of journeys) {
    if (j.clicked) clicked++;
    if (j.reachedForm) reachedForm++;
    if (j.submitted) submitted++;

    // Every journey that reached screen s counts toward screens 0..s.
    const s = Math.max(0, Math.min(4, j.maxStep));
    for (let i = 0; i <= s; i++) depth[i]++;

    if (j.dwell > 0) dwells.push(j.dwell);

    const key = j.src || '';
    let b = bySrc.get(key);
    if (!b) {
      b = { label: key, entered: 0, reachedForm: 0, submitted: 0, firstAt: null, lastAt: null };
      bySrc.set(key, b);
    }
    b.entered++;
    if (j.reachedForm) b.reachedForm++;
    if (j.submitted) b.submitted++;
    // Widen the source's activity window with this visitor's first/last stamps.
    // ISO-8601 UTC strings sort lexicographically, so string compare = time compare.
    if (j.firstAt && (b.firstAt === null || j.firstAt < b.firstAt)) b.firstAt = j.firstAt;
    if (j.lastAt && (b.lastAt === null || j.lastAt > b.lastAt)) b.lastAt = j.lastAt;
  }

  const entered = journeys.length;
  const bySource = [...bySrc.values()].sort((x, y) => y.entered - x.entered);

  return {
    ok: true,
    funnel: {
      entered,
      clicked,
      reachedForm,
      submitted,
      droppedNoForm: entered - reachedForm,
      abandonedForm: reachedForm - submitted,
    },
    totals: buildTotals(rows, nowIso),
    depth,
    medDwellMs: median(dwells),
    bySource,
    generated_at: nowIso,
  };
}

/** Fold the live store. Exposed for reuse/tests; the handler calls this. */
export function summarize(nowIso: string): FunnelSummary {
  return buildSummary(selectRows(trackDb()), nowIso);
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

/** Read the body with a hard cap; aborts the accumulation past MAX_BODY_BYTES. */
function readBodyBounded(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(null));
  });
}

function headerKey(req: http.IncomingMessage): string | null {
  const x = req.headers['x-admin-key'];
  if (typeof x === 'string' && x) return x;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ─── handlers ────────────────────────────────────────────────────────────────

/**
 * POST /track — append one anonymous funnel record. Open + CORS-open, no auth.
 * ALWAYS returns 200 (even on bad/oversized/invalid input) so a fire-and-forget
 * beacon never observes an error.
 */
export async function handleTrack(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    // Not the documented verb, but stay silent-friendly for a beacon endpoint.
    sendJson(res, 200, { ok: true }, CORS_HEADERS);
    return;
  }
  try {
    // text/plain that is actually JSON (sendBeacon default) or application/json.
    const body = await readBodyBounded(req);
    if (body) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      // Require a non-empty vid — no vid means the beacon is missing identity data.
      if (o && typeof o.vid === 'string' && o.vid.trim()) {
        insertRecord(trackDb(), normalizeIncoming(o, new Date().toISOString()));
      }
    }
  } catch (err) {
    // Swallow — persistence failure must not turn into a non-200 for the beacon.
    log.warn('track: append failed', { err });
  }
  sendJson(res, 200, { ok: true }, CORS_HEADERS);
}

/**
 * GET /app/summary — funnel rollup. Gated exactly like /admin/agents: ADMIN_KEY
 * via ?key= or an x-admin-key / Authorization: Bearer header. Never served with
 * CORS — this is the private, server-to-server read the Vercel proxy calls.
 */
export async function handleAppSummary(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isAdminKeyConfigured()) {
    sendJson(res, 503, { ok: false, error: 'ADMIN_KEY not configured' });
    return;
  }
  const u = new URL(req.url || '/', 'http://localhost');
  const key = u.searchParams.get('key') || headerKey(req);
  if (!adminKeyOk(key)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unauthorized');
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  try {
    sendJson(res, 200, summarize(new Date().toISOString()));
  } catch (err) {
    log.error('app/summary: build failed', { err });
    sendJson(res, 500, { ok: false, error: 'summary failed' });
  }
}
