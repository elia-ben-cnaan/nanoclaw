#!/usr/bin/env node
/**
 * One-off, idempotent pre-seed of the WhatsApp identity registry so that
 * flipping WHATSAPP_LOOP_GUARD=1 does NOT fail-closed the existing live
 * WhatsApp agents (the ~60-group host already has 22 wired WhatsApp agents
 * across two host instances). Run AFTER migration 027, BEFORE the flag flip.
 *
 * Calls the REAL guard API (registerWhatsAppAccount / bindWhatsAppAgent) with
 * the guard forced on IN-PROCESS ONLY, so normalization + rows are byte-identical
 * to runtime self-register. No host restart, no external message is sent.
 *
 * Accounts (host sending identities, NEVER customer numbers):
 *   whatsapp        <- baileys sock.user.id, read from store/auth/creds.json
 *   whatsapp-cloud  <- Graph display_phone_number of WHATSAPP_PHONE_NUMBER_ID
 *                      (override via env WHATSAPP_SEED_CLOUD_PHONE)
 * Bindings: every agent wired to a whatsapp messaging group, per its instance.
 *
 * Idempotent: accounts ON CONFLICT, bindings INSERT OR IGNORE. Re-runnable.
 * Run from the repo root of the LIVE checkout with the live env/cwd:
 *   node scripts/seed-whatsapp-identities.mjs
 * Exit 0 = registry fully populated and safe to flip. Non-zero = STOP.
 */
process.env.WHATSAPP_LOOP_GUARD = '1'; // in-process ONLY; never written to .env

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DATA_DIR } from '../dist/config.js';
import { getDb, hasTable, initDb } from '../dist/db/connection.js';
import { registerWhatsAppAccount, bindWhatsAppAgent } from '../dist/whatsapp-agent-identities.js';

function die(msg) {
  console.error('SEED ABORT:', msg);
  process.exit(1);
}

// open live db via host DATA_DIR (same as index.ts); also enables foreign_keys=ON
// which the bindings->accounts FK depends on.
initDb(path.join(DATA_DIR, 'v2.db'));

const db = getDb();
if (!hasTable(db, 'whatsapp_agent_accounts') || !hasTable(db, 'whatsapp_agent_bindings'))
  die('migration 027 not applied (identity tables missing)');

// --- account phones (provider-confirmed, read-only) ---
let baileysId;
try {
  const creds = JSON.parse(readFileSync(new URL('../store/auth/creds.json', import.meta.url), 'utf8'));
  baileysId = creds?.me?.id;
} catch {
  /* handled below */
}
if (!baileysId) die('cannot read baileys me.id from store/auth/creds.json');

const CLOUD_DISPLAY = process.env.WHATSAPP_SEED_CLOUD_PHONE || '+972 54-787-2636';

// accounts first: whatsapp_agent_bindings.instance FK depends on them
registerWhatsAppAccount('whatsapp', baileysId); // -> 972522258800
registerWhatsAppAccount('whatsapp-cloud', CLOUD_DISPLAY); // -> 972547872636

// --- bindings from live wiring ---
const rows = db
  .prepare(
    `SELECT DISTINCT mga.agent_group_id AS agent, mg.instance AS instance
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      WHERE mg.channel_type = 'whatsapp'`,
  )
  .all();
for (const r of rows) bindWhatsAppAgent(r.agent, r.instance);

// --- blocking verification ---
const accounts = db.prepare('SELECT instance,phone,ready FROM whatsapp_agent_accounts ORDER BY instance').all();
const bindings = db.prepare('SELECT COUNT(*) c FROM whatsapp_agent_bindings').get().c;
const wiredInstances = db
  .prepare(`SELECT DISTINCT mg.instance i FROM messaging_groups mg WHERE mg.channel_type='whatsapp'`)
  .all()
  .map((x) => x.i);
const readyInstances = accounts.filter((a) => a.ready === 1).map((a) => a.instance);
const missing = wiredInstances.filter((i) => !readyInstances.includes(i));

console.log('accounts:', JSON.stringify(accounts));
console.log('bindings:', bindings, 'expected(wired agent-instance pairs):', rows.length);
console.log('wired instances:', wiredInstances.join(','), '| ready:', readyInstances.join(','));

let ok = true;
if (missing.length) {
  ok = false;
  console.error('FAIL: wired instances with no ready account:', missing.join(','));
}
if (readyInstances.length !== wiredInstances.length) {
  ok = false;
  console.error('FAIL: ready account count != wired instance count');
}
if (bindings !== rows.length) {
  ok = false;
  console.error('FAIL: binding count != wired agent-instance pair count');
}
if (!ok) process.exit(2);
console.log('SEED OK: registry fully populated, safe to flip WHATSAPP_LOOP_GUARD=1');
