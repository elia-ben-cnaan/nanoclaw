import type { Migration } from './index.js';

/**
 * Durable token-usage history for the operator dashboard.
 *
 * Per-turn usage is captured by the container into each session's
 * outbound.db `usage_events` (append-only). Those rows vanish if a session
 * is deleted, so for retention-over-time the host rolls them up into the
 * central DB:
 *
 *   usage_daily        — per (agent_group_id, UTC day) running totals. Survives
 *                        session/agent deletion, so historical spend is kept.
 *   usage_rollup_state — per-session high-water mark (last rolled `ts`). The
 *                        rollup is ADDITIVE (only events newer than the mark are
 *                        added), so deleting a session never subtracts the spend
 *                        it already contributed.
 *
 * See src/db/usage-metering.ts for the rollup + read logic.
 */
export const migration016: Migration = {
  version: 16,
  name: 'usage-metering-daily',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily (
        agent_group_id        TEXT NOT NULL,
        day                   TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
        in_tokens             INTEGER NOT NULL DEFAULT 0,
        out_tokens            INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        model                 TEXT,
        updated_at            TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, day)
      );

      CREATE TABLE IF NOT EXISTS usage_rollup_state (
        session_id     TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        last_ts        TEXT NOT NULL DEFAULT '',
        updated_at     TEXT NOT NULL
      );
    `);
  },
};
