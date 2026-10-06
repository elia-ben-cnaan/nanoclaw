/**
 * Walk-up consent binding at the WhatsApp Cloud webhook (2026-10-06).
 *
 * Signature layer: @chat-adapter/whatsapp verifies X-Hub-Signature-256 in
 * handleWebhook and answers 401 before any message is dispatched; our pilot
 * interceptor runs inside onInbound, i.e. only on verified payloads.
 *
 * Interceptor layer (bridge + provisioning stubbed, real sqlite):
 *   nonce bind → consent row → code path provisions; same phone idempotent;
 *   other phone rejected; walk-up without consent blocked; walk-up with
 *   consent proceeds; storage failure blocks; gate switch; code-only path
 *   unchanged.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createActivation } from '../modules/pilot-activation/db.js';
import { consentNonceLine, createConsentNonce } from '../modules/pilot-activation/consent-nonce.js';

vi.mock('../provision-handler.js', () => ({
  provisionPilotAtPress: vi.fn(async () => ({ agentGroupId: 'ag-test', slug: 'pilot-test', userName: 'User', lang: 'he' })),
}));
vi.mock('./telegram-joni.js', () => ({
  mirrorToSupervisor: vi.fn(),
  outboundMirrorText: vi.fn(),
  wireJoniChat: vi.fn(),
}));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupAgents: vi.fn(() => []),
  getMessagingGroupByPlatform: vi.fn(() => undefined),
}));
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn((id: string) => (id === 'ag-test' ? { id, folder: 'pilot-test' } : undefined)),
}));

import { wrapWithPilotProvisioning } from './whatsapp-cloud-pilot.js';
import { provisionPilotAtPress } from '../provision-handler.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';

const POLICY = '2026-09-30';
const PHONE_ID = '123456';
const pid = (num: string) => `whatsapp:${PHONE_ID}:${num}`;

const consentRows = () => getDb().prepare('SELECT * FROM consent_records').all() as Record<string, string>[];
const activations = () => getDb().prepare('SELECT * FROM pilot_activations').all() as Record<string, string>[];

function mintPair(meta: Record<string, unknown> = {}) {
  const a = createActivation({ lang: 'he', metadata: { src: 'agent4job', policyVersion: POLICY, consentedAt: 'T0', ...meta } });
  const n = createConsentNonce({ activationCode: a.code, policyVersion: POLICY, consentedAt: 'T0', source: 'agent4job' });
  return { a, n };
}

/** What the landing sends after swapping the opener: no code, nonce line last. */
const swappedOpener = (nonce: string) =>
  `היי ג׳וני 👋\nאשמח שתהיה העוזר האישי שלי במציאת התפקיד הבא שלי. בוא נתחיל!\nהגעתי דרך שירות חיפוש העבודה\n\n${consentNonceLine(nonce)}`;

describe('webhook signature gate (SDK layer)', () => {
  const secret = 'test-app-secret';
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, statuses: [] } }] }],
  });
  const sig = (b: string, s = secret) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

  async function adapter() {
    const mod = await import('@chat-adapter/whatsapp');
    return mod.createWhatsAppAdapter({ phoneNumberId: PHONE_ID, accessToken: 't', appSecret: secret, verifyToken: 'v' });
  }
  const req = (headers: Record<string, string>) =>
    new Request('https://host/webhook/whatsapp-cloud', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('rejects a missing or wrong X-Hub-Signature-256 with 401 before dispatch', async () => {
    const a = await adapter();
    expect((await a.handleWebhook(req({}), { waitUntil: () => {} })).status).toBe(401);
    expect((await a.handleWebhook(req({ 'x-hub-signature-256': sig(body, 'other') }), { waitUntil: () => {} })).status).toBe(401);
    expect((await a.handleWebhook(req({ 'x-hub-signature-256': sig(body + ' ') }), { waitUntil: () => {} })).status).toBe(401);
  });

  it('accepts a valid signature', async () => {
    const a = await adapter();
    expect((await a.handleWebhook(req({ 'x-hub-signature-256': sig(body) }), { waitUntil: () => {} })).status).toBe(200);
  });
});

describe('pilot interceptor (runs after signature verification)', () => {
  let onInbound: ChannelSetup['onInbound'];
  const deliver = vi.fn();
  const host = { onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() };

  beforeEach(async () => {
    runMigrations(initTestDb());
    delete process.env.WALKUP_CONSENT_GATE;
    const bridge = { name: 'whatsapp-cloud', setup: vi.fn(async (c: ChannelSetup) => { onInbound = c.onInbound; }), deliver } as unknown as ChannelAdapter;
    await wrapWithPilotProvisioning(bridge).setup(host as unknown as ChannelSetup);
  });
  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  const send = (num: string, text: string, id = `wamid-${Math.random()}`) =>
    onInbound(pid(num), null, { id, kind: 'chat-sdk', timestamp: '2026-10-06T00:00:00Z', content: { senderId: num, text } } as never);
  const delivered = () => deliver.mock.calls.map((c) => (c[2] as { content: { text: string } }).content.text);

  it('nonce in a swapped opener → bound to the verified phone, one consent row, code path provisions', async () => {
    const { a, n } = mintPair();
    await send('972500000001', swappedOpener(n.nonce));
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0]).toMatchObject({ activation_code: a.code, user_id: 'whatsapp:972500000001', channel: 'whatsapp', policy_version: POLICY });
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(1);
    expect((provisionPilotAtPress as ReturnType<typeof vi.fn>).mock.calls[0][0].activation.code).toBe(a.code);
    expect(activations()[0]).toMatchObject({ status: 'used', used_by_user_id: 'whatsapp:972500000001', agent_group_id: 'ag-test' });
    expect(delivered()).toHaveLength(1); // greeting
    expect(host.onInbound).not.toHaveBeenCalled(); // first message swallowed, never reaches an agent
  });

  it('same phone resends the same nonce → idempotent: no second agent, no second row', async () => {
    const { n } = mintPair();
    await send('972500000001', swappedOpener(n.nonce));
    await send('972500000001', swappedOpener(n.nonce));
    expect(consentRows()).toHaveLength(1);
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(1);
    expect(delivered().at(-1)).toMatch(/הכל כבר מוכן/);
  });

  it('a different phone with the same nonce is rejected: no bind, no provisioning', async () => {
    const { n } = mintPair();
    await send('972500000001', swappedOpener(n.nonce));
    await send('972500000002', swappedOpener(n.nonce));
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0].user_id).toBe('whatsapp:972500000001');
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(1);
    expect(delivered().at(-1)).toMatch(/כבר שימש מספר אחר/);
    expect(host.onInbound).not.toHaveBeenCalled();
  });

  it('walk-up without any consent row is blocked (nothing created, message swallowed)', async () => {
    await send('972500000003', 'היי, אשמח להתחיל');
    expect(provisionPilotAtPress).not.toHaveBeenCalled();
    expect(activations()).toHaveLength(0);
    expect(delivered().at(-1)).toMatch(/מדיניות הפרטיות/);
    expect(host.onInbound).not.toHaveBeenCalled();
  });

  it('walk-up with a consent row already bound to that phone proceeds', async () => {
    getDb()
      .prepare(`INSERT INTO consent_records VALUES ('OLDCODE', ?, 'T0', 'agent4job', 'whatsapp:972500000004', 'whatsapp', 'T1')`)
      .run(POLICY);
    await send('972500000004', 'היי, אשמח להתחיל');
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(1);
    expect(activations()[0]).toMatchObject({ status: 'used', used_by_user_id: 'whatsapp:972500000004' });
    expect(host.onInbound).toHaveBeenCalledTimes(1); // walk-up text falls through to the new agent
  });

  it('WALKUP_CONSENT_GATE=off restores the old walk-up behaviour', async () => {
    process.env.WALKUP_CONSENT_GATE = 'off';
    await send('972500000005', 'היי, אשמח להתחיל');
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(1);
  });

  it('storage failure on bind blocks continuation and leaves the nonce pending (retry-safe)', async () => {
    const { n } = mintPair();
    getDb().exec('DROP TABLE consent_records');
    await send('972500000006', swappedOpener(n.nonce));
    expect(provisionPilotAtPress).not.toHaveBeenCalled();
    expect(delivered().at(-1)).toMatch(/משהו השתבש/);
    expect(getDb().prepare('SELECT status FROM consent_nonces WHERE nonce = ?').get(n.nonce)).toEqual({ status: 'pending' });
    expect(activations()[0].status).toBe('pending');
  });

  it('storage failure on the walk-up gate read blocks too', async () => {
    getDb().exec('DROP TABLE consent_records');
    await send('972500000007', 'היי');
    expect(provisionPilotAtPress).not.toHaveBeenCalled();
    expect(delivered().at(-1)).toMatch(/משהו השתבש/);
  });

  it('code-based activation path is unchanged (code in text, no nonce)', async () => {
    const plain = createActivation({ lang: 'he', metadata: { src: 'agent4job' } });
    await send('972500000008', `שלום ג׳וני\nאשמח להתחיל\n\nקוד הפעלה: ${plain.code}`);
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(1);
    expect(activations()[0]).toMatchObject({ code: plain.code, status: 'used', used_by_user_id: 'whatsapp:972500000008' });
    expect(consentRows()).toHaveLength(0); // no policyVersion → no row, as before

    const consented = createActivation({ lang: 'he', metadata: { src: 'agent4job', policyVersion: POLICY, consentedAt: 'T0' } });
    await send('972500000009', `קוד הפעלה: ${consented.code}`);
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(2);
    expect(consentRows()).toHaveLength(1);
    expect(consentRows()[0]).toMatchObject({ activation_code: consented.code, user_id: 'whatsapp:972500000009' });
  });

  it('host text with BOTH code and nonce (opener not swapped) works and still writes one row', async () => {
    const { a, n } = mintPair();
    await send('972500000010', `שלום ג׳וני\nהגעתי דרך שירות חיפוש העבודה\nאשמח להתחיל\n\nקוד הפעלה: ${a.code}\n${consentNonceLine(n.nonce)}`);
    expect(provisionPilotAtPress).toHaveBeenCalledTimes(1);
    expect(consentRows()).toHaveLength(1);
  });
});
