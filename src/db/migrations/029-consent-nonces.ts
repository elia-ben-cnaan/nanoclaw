import type { Migration } from './index.js';

/**
 * Consent nonces — walk-up consent binding (Shellanoo spec, 2026-10-06).
 *
 * The landing records the user's policy acceptance at /provision, but the
 * walk-up flow (landing → wa.me → WhatsApp) swaps the pre-filled opener and
 * drops the activation code, so that acceptance was never bound to a
 * verified phone and no consent_records row was written.
 *
 * One row per consent intent: minted at /provision alongside the activation
 * code (only when a known policyVersion was accepted), carried as an opaque
 * single-use token in the wa.me text, and bound here to the verified sender
 * ("whatsapp:<number>") by the Meta webhook AFTER X-Hub-Signature-256
 * verification. Binding is atomic (status guard in the UPDATE); a same-phone
 * retry is idempotent; a different phone is rejected.
 *
 * No IP, no user agent — the policy does not list them. Rows are kept for
 * the policy's 7-year retention together with consent_records; the nonce
 * itself is worthless after binding (single-use), so keeping the row is an
 * audit trail, not a secret.
 */
export const migration029: Migration = {
  version: 29,
  name: 'consent-nonces',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS consent_nonces (
        nonce           TEXT PRIMARY KEY,
        activation_code TEXT NOT NULL,
        policy_version  TEXT NOT NULL,
        consented_at    TEXT NOT NULL,
        source          TEXT,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        bound_user_id   TEXT,
        bound_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_consent_nonces_user ON consent_nonces(bound_user_id);
      CREATE INDEX IF NOT EXISTS idx_consent_nonces_activation ON consent_nonces(activation_code);
    `);
  },
};
