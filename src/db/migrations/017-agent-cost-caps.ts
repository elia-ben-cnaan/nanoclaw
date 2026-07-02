import type { Migration } from './index.js';

/**
 * Per-agent daily cost cap (display + enforcement).
 *
 * A global default applies to every pilot (env PILOT_DAILY_COST_CAP_USD,
 * default $1.00/day); a row here overrides the cap for a single agent, so the
 * cap is genuinely per-agent, not only global. Enforcement lives in the router
 * (src/router.ts): once an agent's rolled-up cost for the UTC day reaches its
 * cap, further inbound messages get a fixed "cap reached" reply instead of
 * waking the container. See src/db/usage-metering.ts for the cap resolution.
 */
export const migration017: Migration = {
  version: 17,
  name: 'agent-cost-caps',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_cost_caps (
        agent_group_id TEXT PRIMARY KEY,
        cap_usd        REAL NOT NULL,
        updated_at     TEXT NOT NULL
      );
    `);
  },
};
