/**
 * Regression test for the admin dashboard "משתמש" (user) field.
 *
 * Before this fix, buildAgentView sourced the display name from the legacy
 * telegram-pairings.json file, which the current pilot_activations-based
 * provisioning flow never writes to — so every hosted pilot showed a TODO
 * placeholder instead of the name typed into the signup form. The real
 * source of truth is pilot_activations.metadata, linked to the agent via
 * agent_group_id (set at consume time in provision-handler.ts).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-admin-dashboard' };
});

const TEST_DIR = '/tmp/nanoclaw-test-admin-dashboard';

const { listContainersByNamePrefix, stopContainer } = vi.hoisted(() => ({
  listContainersByNamePrefix: vi.fn().mockReturnValue([]),
  stopContainer: vi.fn(),
}));
vi.mock('./container-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runtime.js')>('./container-runtime.js');
  return { ...actual, listContainersByNamePrefix, stopContainer };
});

import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { createActivation, consumeActivation } from './modules/pilot-activation/db.js';
import {
  buildAgentView,
  readRegistrationInfo,
  funnelStage,
  checkStuck,
  deleteAgent,
  cleanupAgentDisk,
  buildSourceBreakdown,
  buildFunnelBreakdown,
  type AgentView,
} from './admin-dashboard.js';
import { sessionDir, inboundDbPath, outboundDbPath } from './session-manager.js';

const now = () => new Date().toISOString();

describe('dashboard user field reads real signup data', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('shows the name from the signup form, not the TODO placeholder', () => {
    const activation = createActivation({
      lang: 'he',
      metadata: { name: 'דנה כהן', gender: 'f', phone: '0501234567', email: 'dana@example.com' },
    });
    createAgentGroup({ id: 'ag-1', name: 'ג׳וני', folder: 'pilot-abc123', agent_provider: null, created_at: now() });
    consumeActivation(activation.code, { userId: 'telegram:99', agentGroupId: 'ag-1' });

    const view = buildAgentView('pilot-abc123');
    expect(view).not.toBeNull();
    expect(view!.userName).toBe('דנה כהן');
    expect(view!.phone).toBe('0501234567');
    expect(view!.email).toBe('dana@example.com');
  });

  it('falls back to null (renders as TODO) when no activation is linked', () => {
    createAgentGroup({ id: 'ag-2', name: 'ג׳וני', folder: 'pilot-orphaned', agent_provider: null, created_at: now() });
    const view = buildAgentView('pilot-orphaned');
    expect(view).not.toBeNull();
    expect(view!.userName).toBeNull();
    expect(view!.phone).toBeNull();
    expect(view!.email).toBeNull();
  });

  it('bare-start signups (Telegram display name, no phone/email) still show a name', () => {
    const activation = createActivation({ lang: 'he', metadata: { name: 'עידן', gender: 'm' } });
    createAgentGroup({ id: 'ag-3', name: 'ג׳וני', folder: 'pilot-bare', agent_provider: null, created_at: now() });
    consumeActivation(activation.code, { userId: 'telegram:77', agentGroupId: 'ag-3' });

    const info = readRegistrationInfo('ag-3');
    expect(info.userName).toBe('עידן');
    expect(info.phone).toBeNull();
    expect(info.email).toBeNull();
  });

  it('readRegistrationInfo never throws on a corrupted metadata blob', () => {
    const activation = createActivation({ lang: 'he', metadata: { name: 'X' } });
    createAgentGroup({ id: 'ag-4', name: 'Y', folder: 'pilot-garbage', agent_provider: null, created_at: now() });
    consumeActivation(activation.code, { userId: 'telegram:1', agentGroupId: 'ag-4' });
    getDb().prepare('UPDATE pilot_activations SET metadata = ? WHERE code = ?').run('{not valid json', activation.code);

    const info = readRegistrationInfo('ag-4');
    expect(info).toEqual({ userName: null, phone: null, email: null, source: null });
  });

  it('captures the signup source (?src=) and falls back to null when absent', () => {
    const withSrc = createActivation({
      lang: 'he',
      metadata: { name: 'עומר', src: 'linkedin-postA' },
    });
    createAgentGroup({ id: 'ag-5', name: 'ג׳וני', folder: 'pilot-src', agent_provider: null, created_at: now() });
    consumeActivation(withSrc.code, { userId: 'telegram:5', agentGroupId: 'ag-5' });

    createAgentGroup({ id: 'ag-6', name: 'ג׳וני', folder: 'pilot-nosrc', agent_provider: null, created_at: now() });

    expect(readRegistrationInfo('ag-5').source).toBe('linkedin-postA');
    expect(readRegistrationInfo('ag-6').source).toBeNull();

    const view = buildAgentView('pilot-src');
    expect(view!.source).toBe('linkedin-postA');
  });
});

describe('funnel stage derivation (no new storage, computed from existing fields)', () => {
  it('no messages yet -> "opened, never talked"', () => {
    expect(funnelStage(0, '2026-07-10T10:00:00Z', null)).toBe('not-talked');
    expect(funnelStage(null, '2026-07-10T10:00:00Z', null)).toBe('not-talked');
  });

  it('messages same day as opened -> "talked once"', () => {
    expect(funnelStage(3, '2026-07-10T10:00:00Z', '2026-07-10T18:00:00Z')).toBe('talked-once');
  });

  it('last activity on a later calendar day than opened -> "returned the next day"', () => {
    expect(funnelStage(3, '2026-07-10T10:00:00Z', '2026-07-11T09:00:00Z')).toBe('returned');
  });

  it('missing createdAt or lastActiveAt with messages present -> falls back to talked-once, never throws', () => {
    expect(funnelStage(2, null, '2026-07-11T09:00:00Z')).toBe('talked-once');
    expect(funnelStage(2, '2026-07-10T10:00:00Z', null)).toBe('talked-once');
  });
});

describe('stuck flag (real signals only, no new storage)', () => {
  const agentGroupId = 'ag-stuck';
  const sessionId = 'sess-stuck';

  function seedDbs(opts: { inboundRows?: Array<{ status: string; timestamp: string }>; outboundTimestamps?: string[] }) {
    fs.mkdirSync(sessionDir(agentGroupId, sessionId), { recursive: true });

    const inDb = new Database(inboundDbPath(agentGroupId, sessionId));
    inDb.exec(`CREATE TABLE messages_in (id TEXT PRIMARY KEY, status TEXT, timestamp TEXT, kind TEXT)`);
    (opts.inboundRows ?? []).forEach((row, idx) => {
      inDb
        .prepare('INSERT INTO messages_in (id, status, timestamp, kind) VALUES (?, ?, ?, ?)')
        .run(`m${idx}`, row.status, row.timestamp, 'chat-sdk');
    });
    inDb.close();

    const outDb = new Database(outboundDbPath(agentGroupId, sessionId));
    outDb.exec(`CREATE TABLE messages_out (id TEXT PRIMARY KEY, timestamp TEXT)`);
    (opts.outboundTimestamps ?? []).forEach((ts, idx) => {
      outDb.prepare('INSERT INTO messages_out (id, timestamp) VALUES (?, ?)').run(`o${idx}`, ts);
    });
    outDb.close();
  }

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a message the host gave up retrying -> stuck', () => {
    seedDbs({ inboundRows: [{ status: 'failed', timestamp: new Date().toISOString() }] });
    expect(checkStuck(agentGroupId, sessionId, false)).toBe(true);
  });

  it('inbound answered by a later outbound reply -> not stuck', () => {
    const t0 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const t1 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    seedDbs({ inboundRows: [{ status: 'done', timestamp: t0 }], outboundTimestamps: [t1] });
    expect(checkStuck(agentGroupId, sessionId, false)).toBe(false);
  });

  it('answered, but outbound.timestamp uses SQLite datetime() format (space, no zone) -> still not stuck', () => {
    // Regression: messages_in uses ISO with 'T'/'Z' (toISOString), messages_out
    // uses SQLite's own datetime('now') — space-separated, no zone marker.
    // Raw string comparison sorts ' ' (0x20) below 'T' (0x54), so a real reply
    // minted seconds after the inbound message looked "earlier" and the agent
    // was flagged stuck even though it had answered. This is exactly the shape
    // real rows have (verified against production data).
    const inboundIso = '2026-07-11T13:55:32.000Z';
    const outboundSqlite = '2026-07-11 13:55:44'; // 12s after inboundIso, chronologically
    seedDbs({ inboundRows: [{ status: 'completed', timestamp: inboundIso }], outboundTimestamps: [outboundSqlite] });
    expect(checkStuck(agentGroupId, sessionId, false)).toBe(false);
  });

  it('inbound unanswered for over the threshold with the container not running -> stuck', () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedDbs({ inboundRows: [{ status: 'pending', timestamp: old }] });
    expect(checkStuck(agentGroupId, sessionId, false)).toBe(true);
  });

  it('inbound unanswered but container is currently live -> not stuck (still mid-turn)', () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedDbs({ inboundRows: [{ status: 'pending', timestamp: old }] });
    expect(checkStuck(agentGroupId, sessionId, true)).toBe(false);
  });

  it('inbound unanswered but still within the tolerance window -> not stuck yet', () => {
    const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    seedDbs({ inboundRows: [{ status: 'pending', timestamp: recent }] });
    expect(checkStuck(agentGroupId, sessionId, false)).toBe(false);
  });

  it('missing session DBs -> not stuck (never fakes a signal)', () => {
    expect(checkStuck('ag-nonexistent', 'sess-nonexistent', false)).toBe(false);
  });
});

describe('deleteAgent cascade + orphaned-container cleanup', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    listContainersByNamePrefix.mockReset().mockReturnValue([]);
    stopContainer.mockReset();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function seedFullPilot(agentGroupId: string, folder: string) {
    const db = getDb();
    createAgentGroup({ id: agentGroupId, name: 'ג׳וני', folder, agent_provider: null, created_at: now() });
    const activation = createActivation({ lang: 'he', metadata: { name: 'טסט' } });
    consumeActivation(activation.code, { userId: 'telegram:1', agentGroupId });
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at)
       VALUES (?, ?, NULL, NULL, 'active', 'stopped', ?)`,
    ).run('sess-1', agentGroupId, now());
    return activation.code;
  }

  it('deletes the agent_groups row, its sessions, and the linked pilot_activations row', () => {
    const code = seedFullPilot('ag-del-1', 'pilot-del1');

    deleteAgent('ag-del-1', 'pilot-del1');

    const db = getDb();
    expect(db.prepare('SELECT * FROM agent_groups WHERE id = ?').get('ag-del-1')).toBeUndefined();
    expect(db.prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all('ag-del-1')).toEqual([]);
    expect(db.prepare('SELECT * FROM pilot_activations WHERE code = ?').get(code)).toBeUndefined();
  });

  it('sweeps orphaned containers by folder name prefix even with no in-memory tracking', () => {
    seedFullPilot('ag-del-2', 'pilot-del2');
    listContainersByNamePrefix.mockReturnValue(['nanoclaw-v2-pilot-del2-1234567890']);

    const result = deleteAgent('ag-del-2', 'pilot-del2');

    expect(listContainersByNamePrefix).toHaveBeenCalledWith('nanoclaw-v2-pilot-del2-');
    expect(stopContainer).toHaveBeenCalledWith('nanoclaw-v2-pilot-del2-1234567890');
    expect(result.containersStopped).toEqual(['nanoclaw-v2-pilot-del2-1234567890']);
  });

  it('one orphaned container failing to stop does not block the rest of the delete', () => {
    seedFullPilot('ag-del-3', 'pilot-del3');
    listContainersByNamePrefix.mockReturnValue(['nanoclaw-v2-pilot-del3-111']);
    stopContainer.mockImplementation(() => {
      throw new Error('container already gone');
    });

    const result = deleteAgent('ag-del-3', 'pilot-del3');

    expect(result.containersStopped).toEqual([]);
    expect(getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get('ag-del-3')).toBeUndefined();
  });

  it('end-to-end: agent row, container, and on-disk session folder are all gone after delete', () => {
    const agentGroupId = 'ag-del-e2e';
    const folder = 'pilot-dele2e';
    seedFullPilot(agentGroupId, folder);
    listContainersByNamePrefix.mockReturnValue([`nanoclaw-v2-${folder}-9999999999`]);
    fs.mkdirSync(sessionDir(agentGroupId, 'sess-1'), { recursive: true });
    fs.writeFileSync(`${sessionDir(agentGroupId, 'sess-1')}/marker.txt`, 'x');

    const result = deleteAgent(agentGroupId, folder);
    const cleaned = cleanupAgentDisk(agentGroupId, folder);

    // card gone (agent_groups row removed -> buildAgentView/listPilotFolders won't find it)
    expect(getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(agentGroupId)).toBeUndefined();
    // container stopped
    expect(stopContainer).toHaveBeenCalledWith(`nanoclaw-v2-${folder}-9999999999`);
    expect(result.containersStopped).toEqual([`nanoclaw-v2-${folder}-9999999999`]);
    // disk cleaned (cleanupAgentDisk removes the whole agent-group sessions dir, recursively)
    expect(cleaned.some((p) => sessionDir(agentGroupId, 'sess-1').startsWith(p))).toBe(true);
    expect(fs.existsSync(sessionDir(agentGroupId, 'sess-1'))).toBe(false);
  });
});

describe('pilot-wide overview: source + funnel breakdowns (aggregation only, no new storage)', () => {
  function agent(overrides: Partial<AgentView>): AgentView {
    return {
      slug: 'pilot-x',
      agentGroupId: 'ag-x',
      friendlyName: null,
      userName: null,
      phone: null,
      email: null,
      source: null,
      telegramChat: null,
      status: 'live',
      liveNow: false,
      createdAt: null,
      lastActiveAt: null,
      messageCount: null,
      funnelStage: 'not-talked',
      stuck: false,
      tokensTodayIn: 0,
      tokensTodayOut: 0,
      tokensToday: 0,
      estCostTodayUsd: 0,
      capLimit: 0,
      capRemaining: 0,
      costCapUsd: 0,
      costCapReached: false,
      model: null,
      connections: [],
      ...overrides,
    };
  }

  it('groups by source, largest first', () => {
    const agents = [
      agent({ source: 'linkedin-postA' }),
      agent({ source: 'whatsapp-main' }),
      agent({ source: 'whatsapp-main' }),
      agent({ source: 'whatsapp-main' }),
    ];
    expect(buildSourceBreakdown(agents)).toEqual([
      { source: 'whatsapp-main', count: 3 },
      { source: 'linkedin-postA', count: 1 },
    ]);
  });

  it('missing source falls back to "לא ידוע", not an error', () => {
    const agents = [agent({ source: null }), agent({ source: '' }), agent({ source: 'facebook-ad1' })];
    expect(buildSourceBreakdown(agents)).toEqual([
      { source: 'לא ידוע', count: 2 },
      { source: 'facebook-ad1', count: 1 },
    ]);
  });

  it('a brand-new src value never seen in code shows up automatically', () => {
    const agents = [agent({ source: 'instagram-story-2026-q3' })];
    expect(buildSourceBreakdown(agents)).toEqual([{ source: 'instagram-story-2026-q3', count: 1 }]);
  });

  it('empty agent list -> empty breakdown', () => {
    expect(buildSourceBreakdown([])).toEqual([]);
  });

  it('counts every funnel stage, including zero for stages nobody is in', () => {
    const agents = [
      agent({ funnelStage: 'not-talked' }),
      agent({ funnelStage: 'not-talked' }),
      agent({ funnelStage: 'talked-once' }),
    ];
    expect(buildFunnelBreakdown(agents)).toEqual({ 'not-talked': 2, 'talked-once': 1, returned: 0 });
  });

  it('empty agent list -> all stages zero', () => {
    expect(buildFunnelBreakdown([])).toEqual({ 'not-talked': 0, 'talked-once': 0, returned: 0 });
  });
});
