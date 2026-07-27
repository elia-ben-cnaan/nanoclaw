import type { Migration } from './index.js';

/**
 * Hard guard against autonomous posting to GROUP chats. By default an agent
 * may never deliver to a messaging group with `is_group=1` — even its own
 * origin chat, even when @-mentioned. A human grants an explicit allowance
 * row here (per agent group × messaging group) to open a specific group up.
 * `approver` records who granted it.
 */
export const migration022: Migration = {
  version: 22,
  name: 'group-post-allowances',
  up(db) {
    db.exec(`
      CREATE TABLE group_post_allowances (
        agent_group_id     TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        approver           TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, messaging_group_id)
      );
    `);
  },
};
