/**
 * Self-service QA harness for the standing pilot test agent (pilot-12d5ec /
 * "עדי בן כנען", no real history, safe to hammer). Same pattern as
 * scripts/test-codexi-e2e.ts: a dedicated test messaging group wired only to
 * the target agent group, message written via the same shape the router
 * produces, container woken, reply polled from outbound.db.
 *
 * Runs a fixed sequence of prompts one at a time (waits for each reply
 * before sending the next — a real conversation, not a burst) and prints a
 * transcript. Does not touch the agent's real Telegram wiring/session.
 *
 * Usage: pnpm exec tsx scripts/qa-pilot-interview.ts
 */
import { getDb, initDb } from '../src/db/connection.js';
import { getMessagingGroup, createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';
import { resolveSession, writeSessionRouting, writeSessionMessage, openInboundDb, openOutboundDb } from '../src/session-manager.js';
import { wakeContainer } from '../src/container-runner.js';
import { getSession } from '../src/db/sessions.js';

const PILOT_AGENT_GROUP_ID = 'ag-1784284054772-bc3a41a5'; // pilot-12d5ec, standing test agent
const TEST_MG_ID = 'mg-pilot-qa-test';
const TEST_PLATFORM_ID = 'pilot-qa-test-chat';

const QUESTIONS = [
  'שלום, אני רוצה להתחיל',
  'מה השם שלי?',
  'Switch to English',
  'תחזור לעברית',
  'תקבע לי פגישה מחר ב-10 בבוקר בנושא בדיקת המערכת',
  'נראה לי שזה לא נשמר, תבדוק',
  'מה יש לי ביומן השבוע?',
  'תשדרג לי את המודל שלך',
  'אני רוצה לדבר עם אליה',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReply(sessionId: string, afterSeq: number, timeoutMs = 60000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = openOutboundDb(PILOT_AGENT_GROUP_ID, sessionId);
    const row = db
      .prepare(`SELECT content FROM messages_out WHERE seq > ? ORDER BY seq ASC LIMIT 1`)
      .get(afterSeq) as { content: string } | undefined;
    db.close();
    if (row) {
      try {
        return (JSON.parse(row.content) as { text?: string }).text ?? row.content;
      } catch {
        return row.content;
      }
    }
    await sleep(2000);
  }
  return null;
}

function maxOutSeq(sessionId: string): number {
  const db = openOutboundDb(PILOT_AGENT_GROUP_ID, sessionId);
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) as m FROM messages_out`).get() as { m: number };
  db.close();
  return row.m;
}

async function main() {
  initDb('data/v2.db');

  let mg = getMessagingGroup(TEST_MG_ID);
  if (!mg) {
    createMessagingGroup({
      id: TEST_MG_ID,
      channel_type: 'test',
      platform_id: TEST_PLATFORM_ID,
      instance: 'test',
      name: 'pilot-qa-test',
      is_group: 0,
      unknown_sender_policy: 'all',
      created_at: new Date().toISOString(),
    });
    mg = getMessagingGroup(TEST_MG_ID);
    console.log('Created test messaging group', TEST_MG_ID);
  }

  const existingWiring = getDb()
    .prepare('SELECT id FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
    .get(TEST_MG_ID, PILOT_AGENT_GROUP_ID);
  if (!existingWiring) {
    createMessagingGroupAgent({
      id: `mga-pilot-qa-${Date.now()}`,
      messaging_group_id: TEST_MG_ID,
      agent_group_id: PILOT_AGENT_GROUP_ID,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    console.log('Wired test messaging group to pilot-12d5ec');
  }

  const { session } = resolveSession(PILOT_AGENT_GROUP_ID, TEST_MG_ID, null, 'shared');
  writeSessionRouting(PILOT_AGENT_GROUP_ID, session.id);
  console.log('Session:', session.id);

  const inDb = openInboundDb(PILOT_AGENT_GROUP_ID, session.id);
  inDb
    .prepare(
      `INSERT OR IGNORE INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('user', 'User', 'channel', 'test', ?)`,
    )
    .run(TEST_PLATFORM_ID);
  inDb.close();

  for (const [i, q] of QUESTIONS.entries()) {
    const beforeSeq = maxOutSeq(session.id);
    const msgId = `qa-${Date.now()}-${i}`;
    writeSessionMessage(PILOT_AGENT_GROUP_ID, session.id, {
      id: msgId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: TEST_PLATFORM_ID,
      channelType: 'test',
      threadId: null,
      content: JSON.stringify({ text: q, sender: 'QA harness', senderId: 'test:qa' }),
    });
    const s = getSession(session.id);
    if (!s) throw new Error('session vanished');
    await wakeContainer(s);

    console.log(`\n[${i + 1}/${QUESTIONS.length}] Q: ${q}`);
    const reply = await waitForReply(session.id, beforeSeq);
    console.log(`A: ${reply ?? '(TIMEOUT — no reply within 60s)'}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
