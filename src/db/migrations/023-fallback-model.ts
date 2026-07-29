import type { Migration } from './index.js';

/**
 * `fallback_model` on `container_configs`: per-group model override for the
 * quota-overflow provider, mirroring `task_model`'s pattern.
 *
 * Previously the fallback provider was always constructed with `model:
 * undefined`, so it fell through to that provider's own env-var default
 * (e.g. Codex's `CODEX_MODEL`) — a single global value shared by every
 * group whose fallback happens to be Codex. That made it impossible to pin
 * a specific fallback model (e.g. `gpt-5.3-codex` instead of a `-pro`
 * variant) for one group without changing it for all of them. NULL keeps
 * the previous behavior (env-var default).
 */
export const migration023: Migration = {
  version: 23,
  name: 'container-fallback-model',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN fallback_model TEXT;`);
  },
};
