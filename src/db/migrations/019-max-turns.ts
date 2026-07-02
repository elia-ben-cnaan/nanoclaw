import type { Migration } from './index.js';

/**
 * `max_turns` on `container_configs`: per-agent-group override for the
 * provider's agentic-loop turn cap (claude provider default: 15). The cap is
 * the pilot cost-control lever — pilots stay at the low default, while a
 * trusted dev/owner agent doing long build-deploy work can be raised so a
 * single inbound message doesn't die mid-task with "Reached maximum number
 * of turns". NULL keeps the provider default.
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-max-turns',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN max_turns INTEGER;`);
  },
};
