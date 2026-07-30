import type { Migration } from './index.js';

/**
 * `cost_notices` — dedup ledger for daily-quota user notices.
 *
 * The router notifies a pilot's user when daily spend crosses 90% of the cap
 * ("approaching") and again when the cap is reached ("exhausted"). Each
 * notice must fire at most once per agent per UTC day; this table is the
 * once-guard (INSERT OR IGNORE, PK dedup). Rows are tiny and self-expiring
 * in relevance (keyed by day), so no cleanup job is needed.
 */
export const migration024: Migration = {
  version: 24,
  name: 'cost-notices',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cost_notices (
        agent_group_id TEXT NOT NULL,
        day            TEXT NOT NULL,
        level          TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, day, level)
      );
    `);
  },
};
