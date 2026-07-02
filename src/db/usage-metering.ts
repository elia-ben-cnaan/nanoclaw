/**
 * Durable token-usage rollup (host side).
 *
 * Containers append per-turn usage into each session's outbound.db
 * `usage_events`. The host rolls those rows up into the central `usage_daily`
 * table so historical spend survives session/agent deletion. The rollup is
 * ADDITIVE: a per-session high-water mark (`usage_rollup_state.last_ts`) means
 * each event is counted exactly once, and deleting a session never subtracts
 * the spend it already contributed.
 *
 * Host reads outbound.db read-only (container is the sole writer). Schema:
 * src/db/migrations/016-usage-metering.ts.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { getDb } from './connection.js';
import { getSessionsByAgentGroup } from './sessions.js';
import { getContainerConfig } from './container-configs.js';
import { outboundDbPath } from '../session-manager.js';
import { readEnvFile } from '../env.js';

/**
 * Per-model pricing, USD per 1M tokens. Tiered (not flat): cache reads are ~10x
 * cheaper than fresh input and dominate agentic turns, so a flat input rate
 * overestimates cost ~7-10x. We store each token component separately and price
 * them correctly. Cache write = 1.25x input (5-min TTL), cache read = 0.1x input.
 */
interface ModelPrice {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}
const PRICING: Record<string, ModelPrice> = {
  'claude-haiku-4-5': { input: 1.0, cacheWrite: 1.25, cacheRead: 0.1, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  'claude-opus-4-8': { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
};
// Unknown/absent model → price as Sonnet (conservative middle estimate).
const DEFAULT_PRICE = PRICING['claude-sonnet-4-6'];

function priceFor(model: string | null | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  if (PRICING[model]) return PRICING[model];
  // Tolerate dated/full ids (e.g. claude-haiku-4-5-20251001) by prefix.
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return DEFAULT_PRICE;
}

function costFromComponents(
  model: string | null | undefined,
  input: number,
  cacheCreation: number,
  cacheRead: number,
  output: number,
): number {
  const p = priceFor(model);
  const usd =
    (input / 1e6) * p.input +
    (cacheCreation / 1e6) * p.cacheWrite +
    (cacheRead / 1e6) * p.cacheRead +
    (output / 1e6) * p.output;
  return Math.round(usd * 10000) / 10000; // 4 dp
}

export interface DayUsage {
  day: string; // YYYY-MM-DD (UTC)
  inTokens: number; // input + cache_creation + cache_read (total input-side volume)
  outTokens: number;
  tokens: number;
  costUsd: number; // tiered, accurate
}

interface DayAccum {
  in: number;
  out: number;
  cc: number;
  cr: number;
  model: string | null;
}

/**
 * Roll up any new usage_events for one agent's sessions into usage_daily.
 * Idempotent and additive — safe to call as often as you like.
 */
export function rollupUsageForAgent(agentGroupId: string): void {
  const db = getDb();
  // The container records usage_events with model=null, so fall back to the
  // agent's configured model for accurate per-model pricing (and the cost cap).
  const configuredModel = getContainerConfig(agentGroupId)?.model ?? null;
  const getState = db.prepare('SELECT last_ts FROM usage_rollup_state WHERE session_id = ?');
  const upsertDaily = db.prepare(
    `INSERT INTO usage_daily (agent_group_id, day, in_tokens, out_tokens, cache_creation_tokens, cache_read_tokens, model, updated_at)
     VALUES (@ag, @day, @in, @out, @cc, @cr, @model, @now)
     ON CONFLICT(agent_group_id, day) DO UPDATE SET
       in_tokens = in_tokens + excluded.in_tokens,
       out_tokens = out_tokens + excluded.out_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       model = COALESCE(excluded.model, usage_daily.model),
       updated_at = excluded.updated_at`,
  );
  const upsertState = db.prepare(
    `INSERT INTO usage_rollup_state (session_id, agent_group_id, last_ts, updated_at)
     VALUES (@sid, @ag, @ts, @now)
     ON CONFLICT(session_id) DO UPDATE SET last_ts = excluded.last_ts, updated_at = excluded.updated_at`,
  );

  for (const s of getSessionsByAgentGroup(agentGroupId)) {
    const p = outboundDbPath(agentGroupId, s.id);
    if (!fs.existsSync(p)) continue;
    const stateRow = getState.get(s.id) as { last_ts: string } | undefined;
    const lastTs = stateRow?.last_ts ?? '';

    let rows: Array<{
      ts: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      model: string | null;
    }> = [];
    try {
      const sdb = new Database(p, { readonly: true });
      try {
        rows = sdb
          .prepare(
            `SELECT ts, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, model
             FROM usage_events WHERE ts > ? ORDER BY ts`,
          )
          .all(lastTs) as typeof rows;
      } finally {
        sdb.close();
      }
    } catch {
      // usage_events absent (pre-metering session) or momentarily locked — skip.
      continue;
    }
    if (rows.length === 0) continue;

    const perDay = new Map<string, DayAccum>();
    let maxTs = lastTs;
    for (const r of rows) {
      const day = r.ts.slice(0, 10); // YYYY-MM-DD
      const acc = perDay.get(day) ?? { in: 0, out: 0, cc: 0, cr: 0, model: null };
      acc.in += r.input_tokens;
      acc.out += r.output_tokens;
      acc.cc += r.cache_creation_tokens;
      acc.cr += r.cache_read_tokens;
      acc.model = r.model || configuredModel || acc.model;
      perDay.set(day, acc);
      if (r.ts > maxTs) maxTs = r.ts;
    }

    const now = new Date().toISOString();
    const apply = db.transaction(() => {
      for (const [day, acc] of perDay) {
        upsertDaily.run({
          ag: agentGroupId,
          day,
          in: acc.in,
          out: acc.out,
          cc: acc.cc,
          cr: acc.cr,
          model: acc.model,
          now,
        });
      }
      upsertState.run({ sid: s.id, ag: agentGroupId, ts: maxTs, now });
    });
    apply();
  }
}

interface DailyRow {
  day: string;
  in_tokens: number;
  out_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  model: string | null;
}

function rowToDay(r: DailyRow): DayUsage {
  const inTokens = r.in_tokens + r.cache_creation_tokens + r.cache_read_tokens;
  return {
    day: r.day,
    inTokens,
    outTokens: r.out_tokens,
    tokens: inTokens + r.out_tokens,
    costUsd: costFromComponents(r.model, r.in_tokens, r.cache_creation_tokens, r.cache_read_tokens, r.out_tokens),
  };
}

/** Per-day usage for an agent over the last `days` days (most recent first). */
export function getUsageHistory(agentGroupId: string, days = 30): DayUsage[] {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT day, in_tokens, out_tokens, cache_creation_tokens, cache_read_tokens, model
       FROM usage_daily WHERE agent_group_id = ? AND day >= ? ORDER BY day DESC`,
    )
    .all(agentGroupId, cutoffDay) as DailyRow[];
  return rows.map(rowToDay);
}

/** All-time totals for an agent from the rollup. Cost is summed per-day so each
 *  day is priced by the model it ran on (pilots may switch models over time). */
export function getUsageTotals(agentGroupId: string): {
  inTokens: number;
  outTokens: number;
  tokens: number;
  costUsd: number;
} {
  const rows = getDb()
    .prepare(
      `SELECT day, in_tokens, out_tokens, cache_creation_tokens, cache_read_tokens, model
       FROM usage_daily WHERE agent_group_id = ?`,
    )
    .all(agentGroupId) as DailyRow[];
  let inTokens = 0;
  let outTokens = 0;
  let costUsd = 0;
  for (const r of rows) {
    const d = rowToDay(r);
    inTokens += d.inTokens;
    outTokens += d.outTokens;
    costUsd += d.costUsd;
  }
  return { inTokens, outTokens, tokens: inTokens + outTokens, costUsd: Math.round(costUsd * 10000) / 10000 };
}

/** Usage for a single UTC day from the rollup (defaults to today). */
export function getUsageForDay(agentGroupId: string, day?: string): DayUsage {
  const d = day ?? new Date().toISOString().slice(0, 10);
  const r = getDb()
    .prepare(
      `SELECT day, in_tokens, out_tokens, cache_creation_tokens, cache_read_tokens, model
       FROM usage_daily WHERE agent_group_id = ? AND day = ?`,
    )
    .get(agentGroupId, d) as DailyRow | undefined;
  return r ? rowToDay(r) : { day: d, inTokens: 0, outTokens: 0, tokens: 0, costUsd: 0 };
}

// ─── per-agent daily cost cap (display + enforcement) ────────────────────────

/** Global default per-agent daily cost cap (USD). Each agent is capped at this
 *  unless it has a row in agent_cost_caps. Display + enforcement; calibrated so
 *  a single agent's spend stays under ~$1/day. */
export const DEFAULT_DAILY_COST_CAP_USD: number = (() => {
  const fromEnv = readEnvFile(['PILOT_DAILY_COST_CAP_USD']);
  const raw = fromEnv['PILOT_DAILY_COST_CAP_USD'] || process.env['PILOT_DAILY_COST_CAP_USD'];
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1.0;
})();

/** Effective daily cost cap for an agent: per-agent override, else the default. */
export function effectiveCostCapUsd(agentGroupId: string): number {
  const row = getDb().prepare('SELECT cap_usd FROM agent_cost_caps WHERE agent_group_id = ?').get(agentGroupId) as
    | { cap_usd: number }
    | undefined;
  return row && row.cap_usd > 0 ? row.cap_usd : DEFAULT_DAILY_COST_CAP_USD;
}

/** Set (or clear) a per-agent cost cap override. cap_usd <= 0 clears it. */
export function setCostCapUsd(agentGroupId: string, capUsd: number): void {
  const db = getDb();
  if (!(capUsd > 0)) {
    db.prepare('DELETE FROM agent_cost_caps WHERE agent_group_id = ?').run(agentGroupId);
    return;
  }
  db.prepare(
    `INSERT INTO agent_cost_caps (agent_group_id, cap_usd, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_group_id) DO UPDATE SET cap_usd = excluded.cap_usd, updated_at = excluded.updated_at`,
  ).run(agentGroupId, capUsd, new Date().toISOString());
}

/** Today's (UTC) cost for an agent, after bringing the rollup current. */
export function dailyCostUsd(agentGroupId: string): number {
  rollupUsageForAgent(agentGroupId);
  return getUsageForDay(agentGroupId).costUsd;
}

/** Enforcement check: has the agent reached its daily cost cap today? */
export function isOverDailyCostCap(agentGroupId: string): boolean {
  return dailyCostUsd(agentGroupId) >= effectiveCostCapUsd(agentGroupId);
}

export type DailyCostAction = 'ok' | 'downgrade' | 'block';

/**
 * Pilot daily-cost policy (graduated, not a hard same-day wall):
 *   - under cap today                              → 'ok'      (proceed)
 *   - over cap today, under cap yesterday          → 'downgrade' (1st day over:
 *       drop to the cheapest model, keep serving — caller decides + proceeds)
 *   - over cap today AND yesterday (2nd day over)  → 'block'   (soft-block)
 * Cap is the per-agent override (agent_cost_caps) or the env default ($1.00).
 */
export function dailyCostAction(agentGroupId: string): DailyCostAction {
  rollupUsageForAgent(agentGroupId);
  const cap = effectiveCostCapUsd(agentGroupId);
  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const yesterdayStr = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const overToday = getUsageForDay(agentGroupId, todayStr).costUsd >= cap;
  if (!overToday) return 'ok';
  const overYesterday = getUsageForDay(agentGroupId, yesterdayStr).costUsd >= cap;
  return overYesterday ? 'block' : 'downgrade';
}
