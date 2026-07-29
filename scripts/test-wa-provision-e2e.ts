/**
 * E2E test of the WhatsApp provision chain against the live DB, with full
 * cleanup. Simulates exactly what the adapter's first-message handler does
 * for a deep-link activation:
 *   mint code (like POST /provision) → extractPilotCode(text) →
 *   consumeActivation → provisionPilotAtPress(channel=WhatsApp) →
 *   wireJoniChat(..., 'whatsapp') → verify → cleanup.
 * The only layer not covered is Baileys transport, which is already proven
 * live (messages from Elia reached the previous agent).
 */
import fs from 'fs';
import path from 'path';

import { createActivation, consumeActivation } from '../src/modules/pilot-activation/db.js';
import { extractPilotCode } from '../src/modules/pilot-activation/activation.js';
import { provisionPilotAtPress } from '../src/provision-handler.js';
import { wireJoniChat } from '../src/channels/telegram-joni.js';
import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../src/db/messaging-groups.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { getDb, initDb } from '../src/db/connection.js';
import { DATA_DIR, GROUPS_DIR } from '../src/config.js';

initDb(path.join(DATA_DIR, 'v2.db'));

const FAKE_JID = '15550001111@s.whatsapp.net';
const FAKE_USER = `whatsapp:${FAKE_JID}`;

function fail(msg: string): never {
  console.error(`❌ FAIL: ${msg}`);
  process.exit(1);
}

const db = getDb();

// --- 1. Mint an activation like POST /provision does
const activation = createActivation({ lang: 'he', metadata: { name: 'בדיקה', gender: 'm' } });
console.log(`1. minted code: ${activation.code}`);

// --- 2. Simulate the wa.me?text=<code> message body
const messageText = activation.code; // wa.me pre-fills exactly the code
const extracted = extractPilotCode(messageText);
if (extracted !== activation.code) fail(`extractPilotCode(${messageText}) → ${extracted}`);
console.log('2. extractPilotCode recognizes the wa.me text ✓');

// Negative: ordinary text must NOT look like a code
if (extractPilotCode('היי מה קורה') !== null) fail('ordinary Hebrew text mistaken for a code');
if (extractPilotCode('hello there') !== null) fail('ordinary English text mistaken for a code');
console.log('   ordinary text is not a code ✓');

// --- 3. Consume + provision with channel=WhatsApp
const consumed = consumeActivation(activation.code, { userId: FAKE_USER, agentGroupId: `pending-${Date.now()}` });
if (!consumed) fail('consumeActivation returned null for a fresh code');
const prov = provisionPilotAtPress({ activation: consumed, fallbackName: 'בדיקה', channel: 'WhatsApp' });
console.log(`3. provisioned agent ${prov.agentGroupId} slug=${prov.slug}`);

// Double consume must fail (code is one-time)
if (consumeActivation(activation.code, { userId: FAKE_USER, agentGroupId: 'x' })) fail('code consumable twice');
console.log('   code is one-time ✓');

// --- 4. Wire like the adapter does
wireJoniChat(FAKE_JID, prov.agentGroupId, FAKE_USER, 'בדיקה', 'whatsapp');

// --- 5. Verify every layer
const mg = getMessagingGroupByPlatform('whatsapp', FAKE_JID);
if (!mg) fail('messaging group not found under channel_type=whatsapp (the wireJoniChat channel bug)');
console.log(`4. messaging group ${mg.id} channel_type=${mg.channel_type} ✓`);

const wirings = getMessagingGroupAgents(mg.id);
if (wirings.length !== 1 || wirings[0].agent_group_id !== prov.agentGroupId) fail('wiring wrong');
console.log('5. exclusive wiring to fresh agent ✓');

const ag = getAgentGroup(prov.agentGroupId);
if (!ag) fail('agent group missing');

const cc = db.prepare('SELECT model, effort, fallback_provider, assistant_name FROM container_configs WHERE agent_group_id = ?').get(prov.agentGroupId) as any;
console.log(`6. container config: model=${cc?.model} effort=${cc?.effort} fallback=${cc?.fallback_provider} name=${cc?.assistant_name}`);

const cap = db.prepare('SELECT cap_usd FROM agent_cost_caps WHERE agent_group_id = ?').get(prov.agentGroupId) as any;
if (!cap) fail('no cost cap row');
console.log(`7. cost cap: $${cap.cap_usd}/day ✓`);
if (cc?.model !== 'claude-haiku-4-5') fail(`pilot model is ${cc?.model}, expected claude-haiku-4-5`);

const supDest = db.prepare("SELECT local_name FROM agent_destinations WHERE agent_group_id = 'ag-1780401001748-zriukn' AND target_id = ?").get(prov.agentGroupId) as any;
console.log(`8. Daniela → pilot destination: ${supDest ? supDest.local_name + ' ✓' : 'MISSING ❌'}`);

const instrPath = path.join(GROUPS_DIR, prov.slug, 'CLAUDE.local.md');
const instr = fs.existsSync(instrPath) ? fs.readFileSync(instrPath, 'utf8') : '';
if (!instr) fail(`instructions file missing at ${instrPath}`);
// pilot_agent_script_v2.md is channel-agnostic (only {{USER_NAME}}), so just
// verify the identity block landed and nothing claims the wrong channel.
if (!instr.includes('בדיקה')) fail('user identity block missing from instructions');
if (/telegram/i.test(instr)) fail('instructions unexpectedly mention Telegram');
console.log('9. instructions file exists with identity block, channel-clean ✓');

const member = db.prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?').get(FAKE_USER, prov.agentGroupId);
if (!member) fail('sender not a member of the new agent group');
console.log('10. sender registered as member ✓');

// --- 6. Cleanup (reverse order, FK-safe)
console.log('--- cleanup ---');
db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(prov.agentGroupId);
db.prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?').run(mg.id);
db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(prov.agentGroupId);
db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mg.id);
db.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ? OR target_id = ?').run(prov.agentGroupId, prov.agentGroupId);
db.prepare('DELETE FROM agent_cost_caps WHERE agent_group_id = ?').run(prov.agentGroupId);
db.prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(prov.agentGroupId);
db.prepare('DELETE FROM agent_groups WHERE id = ?').run(prov.agentGroupId);
db.prepare('DELETE FROM pilot_activations WHERE code = ?').run(activation.code);
db.prepare('DELETE FROM users WHERE id = ?').run(FAKE_USER);
fs.rmSync(path.join(GROUPS_DIR, prov.slug), { recursive: true, force: true });
console.log('cleanup done — no test artifacts left');
console.log('\n✅ ALL CHECKS PASSED');
