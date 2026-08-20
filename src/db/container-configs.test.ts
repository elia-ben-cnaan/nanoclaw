/**
 * ensureContainerConfig provider stamping (global-default-provider feature).
 *
 * Two load-bearing guarantees:
 *   1. A fresh row is stamped with the given provider (claude → NULL), so a new
 *      group is created on the instance default.
 *   2. An existing row is never overwritten (INSERT OR IGNORE), so enabling a
 *      non-claude default never retroactively flips existing groups.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import { ensureContainerConfig, getContainerConfig } from './container-configs.js';

function makeGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

describe('ensureContainerConfig provider stamping', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('stamps a non-default provider on a fresh row; claude is stored as NULL', () => {
    makeGroup('ag-codex');
    ensureContainerConfig('ag-codex', 'codex');
    expect(getContainerConfig('ag-codex')?.provider).toBe('codex');

    makeGroup('ag-claude');
    ensureContainerConfig('ag-claude', 'claude');
    expect(getContainerConfig('ag-claude')?.provider).toBeNull();

    // Casing is normalized to match what resolution lowercases to.
    makeGroup('ag-cased');
    ensureContainerConfig('ag-cased', 'Codex');
    expect(getContainerConfig('ag-cased')?.provider).toBe('codex');

    makeGroup('ag-cased-claude');
    ensureContainerConfig('ag-cased-claude', 'Claude');
    expect(getContainerConfig('ag-cased-claude')?.provider).toBeNull();
  });

  it('never overwrites an existing row — existing groups are not flipped', () => {
    makeGroup('ag-existing');
    ensureContainerConfig('ag-existing', 'codex'); // existing group already on codex
    expect(getContainerConfig('ag-existing')?.provider).toBe('codex');

    // A later bare ensure (defensive re-init, or a changed instance default)
    // must NOT change it — INSERT OR IGNORE keeps the row frozen.
    ensureContainerConfig('ag-existing');
    expect(getContainerConfig('ag-existing')?.provider).toBe('codex');
  });
});

describe('ensureContainerConfig model stamping', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('stamps the instance-default model on a fresh row so new agents never fall through to the SDK (Haiku) default', () => {
    makeGroup('ag-default');
    ensureContainerConfig('ag-default');
    // DEFAULT_AGENT_MODEL — claude-sonnet-4-5 unless an operator overrides via env.
    expect(getContainerConfig('ag-default')?.model).toBe('claude-sonnet-4-5');
  });

  it('honors an explicit model over the default', () => {
    makeGroup('ag-explicit');
    ensureContainerConfig('ag-explicit', null, 'claude-opus-4-8');
    expect(getContainerConfig('ag-explicit')?.model).toBe('claude-opus-4-8');
  });

  it('never overwrites an existing row — existing agents keep their model', () => {
    makeGroup('ag-frozen');
    ensureContainerConfig('ag-frozen', null, 'claude-opus-4-8');
    expect(getContainerConfig('ag-frozen')?.model).toBe('claude-opus-4-8');

    // A later ensure carrying the new default must NOT change the stored model.
    ensureContainerConfig('ag-frozen');
    expect(getContainerConfig('ag-frozen')?.model).toBe('claude-opus-4-8');
  });
});
