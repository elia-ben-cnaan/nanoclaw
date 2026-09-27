/** Local-only Track A acceptance run. Creates and deletes its own scratch DB;
 * no adapters, HTTP clients, live account credentials or containers are started.
 * Run from the staging checkout: tsx src/whatsapp-loop-dry-run.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { registerWhatsAppAccount, requireWhatsAppBinding } from './whatsapp-agent-identities.js';
import { routeInbound, registerMessageInterceptor } from './router.js';
import type { InboundEvent } from './channels/adapter.js';

const parent = path.resolve('work');
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, 'track-a-dry-run-'));
const previous = process.env.WHATSAPP_LOOP_GUARD;
process.env.WHATSAPP_LOOP_GUARD = '1';
try {
  runMigrations(initDb(path.join(scratch, 'synthetic.db')));
  const runId = `track-a-${randomUUID()}`;
  const group = (suffix: string) => ({
    id: `${runId}-${suffix}`,
    name: 'Dry-run Joni',
    folder: `pilot-${runId}-${suffix}`,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  // Simulated authenticated adapter account identities; customer numbers are not used.
  registerWhatsAppAccount('whatsapp', '15553330001:1@s.whatsapp.net');
  registerWhatsAppAccount('whatsapp-cloud', '+15553330002');
  const a = group('A'),
    b = group('B');
  createAgentGroup(a, 'whatsapp');
  createAgentGroup(b, 'whatsapp-cloud');
  let generatedReplies = 0;
  registerMessageInterceptor(async () => {
    generatedReplies++;
    return true;
  });
  const directions = [];
  for (const [from, instance] of [
    ['15553330001', 'whatsapp-cloud'],
    ['15553330002', 'whatsapp'],
  ]) {
    const event: InboundEvent = {
      channelType: 'whatsapp',
      instance,
      platformId: instance === 'whatsapp-cloud' ? `whatsapp:77777:${from}` : `${from}@s.whatsapp.net`,
      threadId: null,
      message: {
        id: `${runId}-${from}`,
        kind: instance === 'whatsapp-cloud' ? 'chat-sdk' : 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({
          senderId: from,
          sender: `${from}@s.whatsapp.net`,
          text: 'Synthetic agent output',
          fromMe: false,
          isBotMessage: false,
        }),
      },
    };
    await routeInbound(event);
    directions.push({ receivingInstance: instance, externalHops: 1, replies: generatedReplies });
  }
  if (generatedReplies !== 0) throw new Error('Loop guard did not stop the first hop');
  const missing = group('missing');
  let creationBlocked = false;
  try {
    createAgentGroup(missing, 'unregistered-test-instance');
  } catch (err) {
    creationBlocked = String(err).includes('WHATSAPP_AGENT_NUMBER_MISSING');
  }
  if (!creationBlocked || getDb().prepare('SELECT 1 FROM agent_groups WHERE id=?').get(missing.id))
    throw new Error('Missing identity creation was not blocked');
  const legacy = group('legacy');
  createAgentGroup(legacy);
  let legacyBlocked = false;
  try {
    requireWhatsAppBinding(legacy.id, 'whatsapp');
  } catch (err) {
    legacyBlocked = String(err).includes('WHATSAPP_AGENT_NUMBER_UNREGISTERED');
  }
  if (!legacyBlocked) throw new Error('Legacy missing binding was not blocked');
  const alerts = getDb().prepare('SELECT code,subject,occurrences FROM whatsapp_loop_alerts ORDER BY code').all();
  if (alerts.length !== 2) throw new Error('Expected two durable alerts');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        runId,
        temporaryAgents: [a.id, b.id],
        directions,
        creationBlocked,
        legacyBlocked,
        alerts,
        liveWrites: 0,
        realWhatsAppSends: 0,
        hostRestarts: 0,
        scratchDeletedOnExit: true,
      },
      null,
      2,
    ),
  );
} finally {
  closeDb();
  fs.rmSync(scratch, { recursive: true, force: true });
  if (previous === undefined) delete process.env.WHATSAPP_LOOP_GUARD;
  else process.env.WHATSAPP_LOOP_GUARD = previous;
}
