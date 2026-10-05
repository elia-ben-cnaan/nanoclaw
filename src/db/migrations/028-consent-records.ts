import type { Migration } from './index.js';

/**
 * Consent records — proof that a landing-page signup accepted a specific
 * privacy-policy version. One row per activation code, written when the code
 * is consumed (identity bound). Deliberately no FK to agent_groups/users: the
 * policy keeps this record up to 7 years, even after the account is closed.
 * No IP, no user agent (not listed in the policy).
 */
export const migration028: Migration = {
  version: 28,
  name: 'consent-records',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS consent_records (
        activation_code TEXT PRIMARY KEY,
        policy_version  TEXT NOT NULL,
        consented_at    TEXT NOT NULL,
        source          TEXT,
        user_id         TEXT NOT NULL,
        channel         TEXT NOT NULL,
        bound_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_consent_records_user ON consent_records(user_id);
    `);
  },
};
