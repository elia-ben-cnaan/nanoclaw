/**
 * One-off, scoped-to-codexi e2e harness for the quota-fallback-silence fix.
 *
 * Creates (idempotently) a synthetic messaging group wired ONLY to the
 * codexi test agent group (53bee9cb-4a9f-4250-a825-08566af77797), resolves
 * a session, writes a chat message straight into that session's inbound.db
 * (same shape the router would produce), and wakes the container.
 *
 * Does NOT touch any other agent group. Safe to re-run.
 *
 * Usage: pnpm exec tsx scripts/test-codexi-e2e.ts "<prompt text>"
 */
import { getDb, initDb } from '../src/db/connection.js';
import { getMessagingGroup, createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';
import { resolveSession, writeSessionRouting, writeSessionMessage, openInboundDb } from '../src/session-manager.js';
import { wakeContainer } from '../src/container-runner.js';
import { getSession } from '../src/db/sessions.js';

const CODEXI_AGENT_GROUP_ID = '53bee9cb-4a9f-4250-a825-08566af77797';
const TEST_MG_ID = 'mg-codexi-e2e-test';
const TEST_PLATFORM_ID = 'codexi-e2e-test-chat';

async function main() {
  initDb('data/v2.db');
  const prompt = process.argv[2] || 'Say the word banana and nothing else.';

  let mg = getMessagingGroup(TEST_MG_ID);
  if (!mg) {
    createMessagingGroup({
      id: TEST_MG_ID,
      channel_type: 'test',
      platform_id: TEST_PLATFORM_ID,
      instance: 'test',
      name: 'codexi-e2e-test',
      is_group: 0,
      unknown_sender_policy: 'all',
      created_at: new Date().toISOString(),
    });
    mg = getMessagingGroup(TEST_MG_ID);
    console.log('Created test messaging group', TEST_MG_ID);
  }

  const existingWiring = getDb()
    .prepare('SELECT id FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
    .get(TEST_MG_ID, CODEXI_AGENT_GROUP_ID);
  if (!existingWiring) {
    createMessagingGroupAgent({
      id: `mga-codexi-e2e-${Date.now()}`,
      messaging_group_id: TEST_MG_ID,
      agent_group_id: CODEXI_AGENT_GROUP_ID,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    console.log('Wired test messaging group to codexi');
  }

  const { session } = resolveSession(CODEXI_AGENT_GROUP_ID, TEST_MG_ID, null, 'shared');
  writeSessionRouting(CODEXI_AGENT_GROUP_ID, session.id);
  console.log('Session:', session.id);

  const msgId = `e2e-${Date.now()}`;
  writeSessionMessage(CODEXI_AGENT_GROUP_ID, session.id, {
    id: msgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: TEST_PLATFORM_ID,
    channelType: 'test',
    threadId: null,
    content: JSON.stringify({ text: prompt, sender: 'Elia (e2e test)', senderId: 'test:elia' }),
  });
  console.log('Wrote inbound message', msgId, JSON.stringify(prompt));

  // Seed a 'user' destination so the container can resolve <message to="user">.
  const inDb = openInboundDb(CODEXI_AGENT_GROUP_ID, session.id);
  inDb
    .prepare(
      `INSERT OR IGNORE INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('user', 'User', 'channel', 'test', ?)`,
    )
    .run(TEST_PLATFORM_ID);
  inDb.close();

  const s = getSession(session.id);
  if (!s) throw new Error('session vanished');
  const woke = await wakeContainer(s);
  console.log('wakeContainer ->', woke);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
