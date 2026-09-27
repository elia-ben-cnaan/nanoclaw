import { createMessagingGroupAgent } from './db/messaging-groups.js';
import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('./group-init.js', () => ({ initGroupFilesystem: vi.fn() }));
vi.mock('./db/container-configs.js', () => ({
  ensureContainerConfig: vi.fn(),
  updateContainerConfigScalars: vi.fn(),
  updateContainerConfigJson: vi.fn(),
}));
vi.mock('./db/usage-metering.js', () => ({ setCostCapUsd: vi.fn() }));
import { initTestDb, closeDb, getDb } from './db/connection.js';
import { migration027 } from './db/migrations/027-whatsapp-agent-identities.js';
import { createAgentGroup } from './db/agent-groups.js';
import {
  discoverWhatsAppCloudAccount,
  registerWhatsAppAccount,
  requireWhatsAppBinding,
  registeredWhatsAppAccounts,
} from './whatsapp-agent-identities.js';
import { whatsappInboundBlockReason } from './whatsapp-loop-guard.js';
import { provisionPilotAtPress } from './provision-handler.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import type { PilotActivation } from './modules/pilot-activation/db.js';

beforeEach(() => {
  delete process.env.WHATSAPP_LOOP_POLICY_FILE;
  process.env.WHATSAPP_LOOP_GUARD = '1';
  const db = initTestDb();
  db.exec('CREATE TABLE agent_groups(id TEXT PRIMARY KEY,name TEXT,folder TEXT,agent_provider TEXT,created_at TEXT)');
  migration027.up(db);
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path).endsWith('/pilot_agent_script_v2.md')) return 'Synthetic {{USER_NAME}} {{CHANNEL}}';
    return (read as (...values: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  vi.spyOn(log, 'error');
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.WHATSAPP_LOOP_GUARD;
  closeDb();
  vi.restoreAllMocks();
});
const group = () => ({
  id: `dry-run-${randomUUID()}`,
  name: 'Synthetic Joni',
  folder: `pilot-test-${randomUUID()}`,
  agent_provider: null,
  created_at: new Date().toISOString(),
});
const activation = (): PilotActivation => ({
  code: 'DRYRUN',
  lang: 'en',
  metadata: JSON.stringify({ name: 'Test', phone: '15559999999' }),
  created_at: '2026-01-01',
  expires_at: '2026-01-02',
  status: 'used',
  used_by_user_id: 'whatsapp:15559999999',
  used_at: '2026-01-01',
  agent_group_id: null,
  pilot_started_at: null,
  pilot_ends_at: null,
});

it('registers the provider-owned phone automatically in actual pilot creation, never the customer number', async () => {
  registerWhatsAppAccount('whatsapp-cloud', '+1 (555) 111-0001');
  const pilot = await provisionPilotAtPress({
    activation: activation(),
    channel: 'WhatsApp',
    whatsappInstance: 'whatsapp-cloud',
  });
  expect(registeredWhatsAppAccounts()).toEqual([{ phone: '15551110001', agents: [pilot.agentGroupId] }]);
  expect(() => requireWhatsAppBinding(pilot.agentGroupId, 'whatsapp-cloud')).not.toThrow();
  expect(initGroupFilesystem).toHaveBeenCalled();
});
it('two temporary pilots on different authenticated accounts stop at the first external hop without a manual number list', () => {
  registerWhatsAppAccount('whatsapp', '15551110001:7@s.whatsapp.net');
  registerWhatsAppAccount('whatsapp-cloud', '+15551110002');
  const a = group(),
    b = group();
  createAgentGroup(a, 'whatsapp');
  createAgentGroup(b, 'whatsapp-cloud');
  let hops = 0,
    replies = 0;
  for (const [instance, from] of [
    ['whatsapp-cloud', '15551110001'],
    ['whatsapp', '15551110002'],
  ]) {
    hops++;
    const reason = whatsappInboundBlockReason({
      channelType: 'whatsapp',
      instance,
      platformId: `${from}@s.whatsapp.net`,
      threadId: null,
      message: {
        id: `dry-${randomUUID()}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({ sender: from, text: 'reply', fromMe: false, isBotMessage: false }),
      },
    });
    if (!reason) replies++;
    expect(reason).toBe('agent_external_max_hops');
  }
  expect(hops).toBe(2);
  expect(replies).toBe(0); // two independent directions, one hop each
  expect(getDb().prepare('SELECT count(*) n FROM whatsapp_agent_bindings').get()).toEqual({ n: 2 });
});
it('missing account stops actual provisioning before agent or filesystem creation and persists a specific alert', async () => {
  await expect(
    provisionPilotAtPress({
      activation: activation(),
      channel: 'WhatsApp',
      whatsappInstance: 'missing-account',
    }),
  ).rejects.toThrow('WHATSAPP_AGENT_NUMBER_MISSING');
  expect(getDb().prepare('SELECT count(*) n FROM agent_groups').get()).toEqual({ n: 0 });
  expect(initGroupFilesystem).not.toHaveBeenCalled();
  expect(getDb().prepare('SELECT code,subject FROM whatsapp_loop_alerts').get()).toEqual({
    code: 'WHATSAPP_AGENT_NUMBER_MISSING',
    subject: 'missing-account',
  });
  expect(log.error).toHaveBeenCalledWith(
    expect.stringContaining('ALERT'),
    expect.objectContaining({ code: 'WHATSAPP_AGENT_NUMBER_MISSING' }),
  );
});
it('an existing unregistered pilot alerts and is blocked; no silent backfill on receipt', () => {
  registerWhatsAppAccount('whatsapp', '15551110001');
  const legacy = group();
  createAgentGroup(legacy);
  expect(() => requireWhatsAppBinding(legacy.id, 'whatsapp')).toThrow('WHATSAPP_AGENT_NUMBER_UNREGISTERED');
  expect(getDb().prepare('SELECT code,subject FROM whatsapp_loop_alerts').get()).toEqual({
    code: 'WHATSAPP_AGENT_NUMBER_UNREGISTERED',
    subject: legacy.id,
  });
});
it('Cloud discovery uses verified account id, not user metadata; discovery failure alerts without secrets', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: '123456', display_phone_number: '+15551110002' }), { status: 200 }),
    );
  await discoverWhatsAppCloudAccount('whatsapp-cloud', '123456', 'synthetic-token', request);
  expect(registeredWhatsAppAccounts()[0].phone).toBe('15551110002');
  request.mockResolvedValue(
    new Response(JSON.stringify({ id: 'wrong', display_phone_number: '+15551110003' }), { status: 200 }),
  );
  await expect(discoverWhatsAppCloudAccount('unverified', '123456', 'synthetic-token', request)).rejects.toThrow(
    'WHATSAPP_AGENT_NUMBER_DISCOVERY_FAILED',
  );
  expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('synthetic-token');
});
it('account rotation fails closed and keeps existing binding unchanged', () => {
  registerWhatsAppAccount('whatsapp', '15551110001');
  const a = group();
  createAgentGroup(a, 'whatsapp');
  expect(() => registerWhatsAppAccount('whatsapp', '15551110002')).toThrow('WHATSAPP_AGENT_ACCOUNT_CHANGED');
  expect(registeredWhatsAppAccounts()).toEqual([{ phone: '15551110001', agents: [a.id] }]);
  expect(() => requireWhatsAppBinding(a.id, 'whatsapp')).toThrow('WHATSAPP_AGENT_NUMBER_MISSING');
});
it('missing identity registry migration emits an explicit alert and rejects traffic', () => {
  getDb().exec('DROP TABLE whatsapp_agent_bindings');
  expect(() => registerWhatsAppAccount('whatsapp', '15551110001')).toThrow('WHATSAPP_IDENTITY_REGISTRY_MISSING');
  expect(log.error).toHaveBeenCalledWith(
    expect.stringContaining('ALERT'),
    expect.objectContaining({ code: 'WHATSAPP_IDENTITY_REGISTRY_MISSING' }),
  );
});

it('automatic account bindings also block a two-account wiring cycle without a manual policy file', () => {
  registerWhatsAppAccount('whatsapp', '15551110001');
  registerWhatsAppAccount('whatsapp-cloud', '15551110002');
  const a = group(),
    b = group();
  createAgentGroup(a, 'whatsapp');
  createAgentGroup(b, 'whatsapp-cloud');
  const db = getDb();
  db.exec(`
    CREATE TABLE messaging_groups(id TEXT PRIMARY KEY,channel_type TEXT,platform_id TEXT,instance TEXT,name TEXT);
    CREATE TABLE messaging_group_agents(id TEXT PRIMARY KEY,messaging_group_id TEXT,agent_group_id TEXT,engage_mode TEXT,engage_pattern TEXT,sender_scope TEXT,ignored_message_policy TEXT,session_mode TEXT,priority INTEGER,created_at TEXT);
    INSERT INTO messaging_groups VALUES ('peer-B','whatsapp','15551110002@s.whatsapp.net','whatsapp','B'),('peer-A','whatsapp','whatsapp:12345:15551110001','whatsapp-cloud','A');
  `);
  const wire = (id: string, agent: string, chat: string) => ({
    id,
    agent_group_id: agent,
    messaging_group_id: chat,
    engage_mode: 'pattern' as const,
    engage_pattern: '.',
    sender_scope: 'all' as const,
    ignored_message_policy: 'drop' as const,
    session_mode: 'shared' as const,
    priority: 0,
    created_at: '2026-01-01',
  });
  createMessagingGroupAgent(wire('wire-A', a.id, 'peer-B'));
  expect(() => createMessagingGroupAgent(wire('wire-B', b.id, 'peer-A'))).toThrow(
    'WhatsApp agent routing cycle blocked',
  );
  expect(db.prepare('SELECT count(*) n FROM messaging_group_agents').get()).toEqual({ n: 1 });
});
