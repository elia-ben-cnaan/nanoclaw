/**
 * Walk-up consent binding — nonce contract (2026-10-06).
 *
 *  - nonce format / extraction (incl. after the landing swapped the opener)
 *  - bind: one consent row, same-phone idempotent, other phone rejected,
 *    expired, unknown, storage failure propagates
 *  - migration 029 applies on a temp COPY of the live v2.db (when readable)
 *  - /provision: nonce minted only with a known policyVersion, ref line is
 *    the last line of the wa.me text, storage failure → 500
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env.js', () => ({ readEnvFile: () => ({ WHATSAPP_BOT_NUMBER: '972500000000' }) }));

import { closeDb, initDb, initTestDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { consumeActivation, createActivation, looksLikePilotCode } from './db.js';
import {
  CONSENT_NONCE_LINE_RE,
  bindConsentNonce,
  consentNonceLine,
  createConsentNonce,
  findConsentNonceInText,
  generateConsentNonce,
  hasConsentRecordForUser,
  looksLikeConsentNonce,
  walkupConsentGateEnabled,
} from './consent-nonce.js';

const LIVE_DB = '/home/daniela/nanoclaw-v2/data/v2.db';
const POLICY = '2026-09-30';

const consentRows = () => getDb().prepare('SELECT * FROM consent_records').all() as Record<string, string>[];
const nonceRows = () => getDb().prepare('SELECT * FROM consent_nonces').all() as Record<string, string>[];

function mintPair(meta: Record<string, unknown> = {}) {
  const a = createActivation({ lang: 'he', metadata: { src: 'agent4job', policyVersion: POLICY, consentedAt: 'T0', ...meta } });
  const n = createConsentNonce({ activationCode: a.code, policyVersion: POLICY, consentedAt: 'T0', source: 'agent4job' });
  return { a, n };
}

describe('consent nonce format', () => {
  it('is opaque, 16 random bytes base64url with the cn_ prefix, and never a pilot code', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = generateConsentNonce();
      expect(n).toMatch(/^cn_[A-Za-z0-9_-]{22}$/);
      expect(looksLikeConsentNonce(n)).toBe(true);
      expect(looksLikePilotCode(n)).toBe(false);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });

  it('is found in the host text and in the landing-swapped opener (last line preserved)', () => {
    const n = generateConsentNonce();
    const hostText = `שלום ג׳וני\nהגעתי דרך שירות חיפוש העבודה\nאשמח להתחיל\n\nקוד הפעלה: ABCDEFGHJKLMNPQRSTUV\n${consentNonceLine(n)}`;
    expect(findConsentNonceInText(hostText)).toBe(n);
    const refLine = hostText.match(CONSENT_NONCE_LINE_RE)![0];
    const swapped = `היי ג׳וני 👋\nאשמח שתהיה העוזר האישי שלי. בוא נתחיל!\nהגעתי דרך שירות חיפוש העבודה\n\n${refLine}`;
    expect(findConsentNonceInText(swapped)).toBe(n);
    expect(swapped.endsWith(consentNonceLine(n))).toBe(true);
    // Users edit the pre-fill: the token still parses mid-text / with punctuation.
    expect(findConsentNonceInText(`hi (${n}).`)).toBe(n);
    expect(findConsentNonceInText(`x${n}`)).toBeNull();
    expect(findConsentNonceInText('no token here cn_short')).toBeNull();
  });
});

describe('bindConsentNonce', () => {
  beforeEach(() => runMigrations(initTestDb()));
  afterEach(() => closeDb());

  it('binds once and writes exactly one consent row (no IP, server bound_at)', () => {
    const { a, n } = mintPair();
    const r = bindConsentNonce(n.nonce, 'whatsapp:972500000001', new Date('2026-10-06T10:00:00Z'));
    expect(r.status).toBe('bound');
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0]).toMatchObject({
      activation_code: a.code,
      policy_version: POLICY,
      consented_at: 'T0',
      source: 'agent4job',
      user_id: 'whatsapp:972500000001',
      channel: 'whatsapp',
      bound_at: '2026-10-06T10:00:00.000Z',
    });
    expect(Object.keys(consentRows()[0])).not.toContain('ip');
    expect(nonceRows()[0]).toMatchObject({ status: 'bound', bound_user_id: 'whatsapp:972500000001' });
    expect(hasConsentRecordForUser('whatsapp:972500000001')).toBe(true);
    expect(hasConsentRecordForUser('whatsapp:972500000002')).toBe(false);
  });

  it('same phone retry is idempotent; a different phone is rejected and nothing moves', () => {
    const { n } = mintPair();
    expect(bindConsentNonce(n.nonce, 'whatsapp:1').status).toBe('bound');
    expect(bindConsentNonce(n.nonce, 'whatsapp:1').status).toBe('already-bound');
    expect(bindConsentNonce(n.nonce, 'whatsapp:2').status).toBe('phone-mismatch');
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0].user_id).toBe('whatsapp:1');
    expect(nonceRows()[0].bound_user_id).toBe('whatsapp:1');
  });

  it('the later code consume upserts the SAME row — still one consent record', () => {
    const { a, n } = mintPair();
    bindConsentNonce(n.nonce, 'whatsapp:1');
    expect(consumeActivation(a.code, { userId: 'whatsapp:1', agentGroupId: 'ag-1' })).not.toBeNull();
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0].user_id).toBe('whatsapp:1');
  });

  it('expired and unknown nonces never bind', () => {
    const { n } = mintPair();
    const late = new Date(Date.now() + 25 * 3600 * 1000);
    expect(bindConsentNonce(n.nonce, 'whatsapp:1', late).status).toBe('expired');
    expect(bindConsentNonce(generateConsentNonce(), 'whatsapp:1').status).toBe('unknown');
    expect(consentRows()).toHaveLength(0);
  });

  it('storage failure propagates (caller blocks continuation)', () => {
    const { n } = mintPair();
    getDb().exec('DROP TABLE consent_records');
    expect(() => bindConsentNonce(n.nonce, 'whatsapp:1')).toThrow();
    // transaction rolled back: nonce still pending
    expect(nonceRows()[0].status).toBe('pending');
    expect(() => hasConsentRecordForUser('whatsapp:1')).toThrow();
  });

  it('gate switch defaults on, env can turn it off', () => {
    delete process.env.WALKUP_CONSENT_GATE;
    expect(walkupConsentGateEnabled()).toBe(true);
    process.env.WALKUP_CONSENT_GATE = 'off';
    expect(walkupConsentGateEnabled()).toBe(false);
    delete process.env.WALKUP_CONSENT_GATE;
  });
});

describe('migration 029 on a temp copy of the live v2.db', () => {
  afterEach(() => closeDb());
  const readable = (() => {
    try {
      fs.accessSync(LIVE_DB, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  })();

  (readable ? it : it.skip)('adds consent_nonces, keeps consent_records and pilot_activations intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-mig-'));
    const copy = path.join(dir, 'v2.db');
    fs.copyFileSync(LIVE_DB, copy);
    const db = initDb(copy);
    const before = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    const consentBefore = (db.prepare('SELECT COUNT(*) AS c FROM consent_records').get() as { c: number }).c;
    runMigrations(db);
    const after = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(after).toBeGreaterThanOrEqual(29);
    expect(after).toBeGreaterThanOrEqual(before);
    const cols = (db.prepare('PRAGMA table_info(consent_nonces)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'nonce', 'activation_code', 'policy_version', 'consented_at', 'source', 'created_at', 'expires_at', 'status', 'bound_user_id', 'bound_at',
    ]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM consent_records').get() as { c: number }).c).toBe(consentBefore);
    // round trip on the real schema
    const { n } = mintPair();
    expect(bindConsentNonce(n.nonce, 'whatsapp:000').status).toBe('bound');
    expect(hasConsentRecordForUser('whatsapp:000')).toBe(true);
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('POST /provision mints the nonce with the consent', () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    runMigrations(initTestDb());
    const { handleProvision } = await import('../../provision-handler.js');
    server = http.createServer((req, res) => void handleProvision(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDb();
  });

  const post = async (body: unknown) => {
    const r = await fetch(`${base}/provision`, { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, j: (await r.json()) as Record<string, any> };
  };

  it('with policyVersion: nonce row + ref line last in the wa.me text; response carries nonce + version', async () => {
    const { status, j } = await post({ src: 'agent4job', channel: 'whatsapp', lang: 'he', policyVersion: POLICY });
    expect(status).toBe(200);
    expect(j.consentNonce).toMatch(/^cn_[A-Za-z0-9_-]{22}$/);
    expect(j.policyVersion).toBe(POLICY);
    const text = decodeURIComponent(new URL(j.whatsapp.deepLink).searchParams.get('text')!);
    expect(text.split('\n').at(-1)).toBe(consentNonceLine(j.consentNonce));
    expect(text).toMatch(/קוד הפעלה: [A-Z2-9]{20}\n/);
    expect(j.whatsapp.text).toBe(text);
    const row = nonceRows()[0];
    expect(row).toMatchObject({ nonce: j.consentNonce, policy_version: POLICY, status: 'pending', source: 'agent4job' });
    expect(consentRows()).toHaveLength(0); // nothing bound yet
  });

  it('without a known policyVersion: no nonce, text unchanged (code-based path intact)', async () => {
    for (const body of [{ src: 'agent4job', channel: 'whatsapp' }, { src: 'agent4job', policyVersion: '1999-01-01' }]) {
      const { status, j } = await post(body);
      expect(status).toBe(200);
      expect(j.consentNonce).toBeNull();
      const text = decodeURIComponent(new URL(j.whatsapp.deepLink).searchParams.get('text')!);
      expect(text).toMatch(/קוד הפעלה: [A-Z2-9]{20}$/);
      expect(findConsentNonceInText(text)).toBeNull();
    }
    expect(nonceRows()).toHaveLength(0);
  });

  it('storage failure → 500 and no half-written activation', async () => {
    getDb().exec('DROP TABLE consent_nonces');
    const { status } = await post({ src: 'agent4job', channel: 'whatsapp', policyVersion: POLICY });
    expect(status).toBe(500);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM pilot_activations').get()).toEqual({ c: 0 });
  });
});
