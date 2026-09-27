import type { Migration } from './index.js';
export const migration027: Migration = {
  version: 27,
  name: 'whatsapp-agent-identities',
  up(db) {
    db.exec(`
      CREATE TABLE whatsapp_agent_accounts (
        instance TEXT PRIMARY KEY, phone TEXT NOT NULL, verified_at TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX whatsapp_agent_accounts_phone ON whatsapp_agent_accounts(phone);
      CREATE TABLE whatsapp_agent_bindings (
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        instance TEXT NOT NULL REFERENCES whatsapp_agent_accounts(instance),
        created_at TEXT NOT NULL, PRIMARY KEY(agent_group_id, instance)
      );
      CREATE TABLE whatsapp_loop_alerts (
        code TEXT NOT NULL, subject TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 1,
        last_seen TEXT NOT NULL, PRIMARY KEY(code, subject)
      );
    `);
  },
};
