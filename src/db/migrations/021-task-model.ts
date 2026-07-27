import type { Migration } from './index.js';

/**
 * `task_model` on `container_configs`: cheap-model override for scheduled-task
 * (watcher) wakes. When set, a batch consisting ONLY of `kind='task'` rows is
 * served by a one-shot turn on this model with no conversation continuation —
 * the wake pays neither the top model's rates nor the full transcript reload.
 * NULL keeps every wake on the primary model (previous behavior).
 */
export const migration021: Migration = {
  version: 21,
  name: 'container-task-model',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN task_model TEXT;`);
  },
};
