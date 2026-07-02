import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getAgentGroupByFolder } from './db/index.js';
import {
  createPairing,
  listPairings,
  _setStorePathForTest,
  type PairingRecord,
} from './channels/telegram-pairing.js';
import { isOrphanPilotPairing, sweepOrphanPilots, ORPHAN_PILOT_GRACE_MS } from './pilot-orphan-sweep.js';

const now = () => new Date().toISOString();

function rec(over: Partial<PairingRecord> = {}): PairingRecord {
  return {
    code: 'abc123',
    intent: { kind: 'new-agent', folder: 'pilot-xyz' },
    createdAt: new Date(Date.now() - ORPHAN_PILOT_GRACE_MS - 1000).toISOString(),
    status: 'pending',
    ...over,
  };
}

describe('isOrphanPilotPairing', () => {
  const T = Date.now();
  it('true: old pending new-agent pilot with no session', () => {
    expect(isOrphanPilotPairing(rec(), T, ORPHAN_PILOT_GRACE_MS, false)).toBe(true);
  });
  it('false: a session exists', () => {
    expect(isOrphanPilotPairing(rec(), T, ORPHAN_PILOT_GRACE_MS, true)).toBe(false);
  });
  it('false: still within the grace window', () => {
    expect(isOrphanPilotPairing(rec({ createdAt: now() }), T, ORPHAN_PILOT_GRACE_MS, false)).toBe(false);
  });
  it('false: pairing already consumed', () => {
    expect(isOrphanPilotPairing(rec({ status: 'consumed' }), T, ORPHAN_PILOT_GRACE_MS, false)).toBe(false);
  });
  it('false: non-pilot folder', () => {
    expect(
      isOrphanPilotPairing(rec({ intent: { kind: 'new-agent', folder: 'other' } }), T, ORPHAN_PILOT_GRACE_MS, false),
    ).toBe(false);
  });
  it("false: 'main' intent (not a provisioned pilot)", () => {
    expect(isOrphanPilotPairing(rec({ intent: 'main' }), T, ORPHAN_PILOT_GRACE_MS, false)).toBe(false);
  });
});

describe('sweepOrphanPilots', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    const storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pair-')), 'pairings.json');
    _setStorePathForTest(storeFile);
  });
  afterEach(() => {
    _setStorePathForTest(null);
    closeDb();
  });

  it('sweeps a registered-but-never-started pilot after the grace', async () => {
    createAgentGroup({ id: 'ag-orphan', name: 'X', folder: 'pilot-orphan', agent_provider: null, created_at: now() });
    const p = await createPairing({ kind: 'new-agent', folder: 'pilot-orphan' });
    const future = Date.now() + ORPHAN_PILOT_GRACE_MS + 60_000;
    const swept = await sweepOrphanPilots(future);
    expect(swept).toBe(1);
    expect(getAgentGroupByFolder('pilot-orphan')).toBeUndefined();
    expect(listPairings().some((r) => r.code === p.code)).toBe(false);
  });

  it('does not sweep within the grace window', async () => {
    createAgentGroup({ id: 'ag-young', name: 'X', folder: 'pilot-young', agent_provider: null, created_at: now() });
    await createPairing({ kind: 'new-agent', folder: 'pilot-young' });
    const swept = await sweepOrphanPilots(Date.now());
    expect(swept).toBe(0);
    expect(getAgentGroupByFolder('pilot-young')).toBeDefined();
  });
});
