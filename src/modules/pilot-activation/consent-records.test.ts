/**
 * Consent records: a landing signup that carried a policyVersion leaves one
 * durable row when its code is consumed; signups without one leave nothing.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { createActivation, consumeActivation } from './db.js';

beforeEach(() => {
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

const rows = () => getDb().prepare('SELECT * FROM consent_records').all() as Record<string, string>[];

describe('consent records', () => {
  it('writes one row bound to the consuming identity', () => {
    const a = createActivation({
      lang: 'he',
      metadata: { src: 'agent4job', policyVersion: '2026-09-30', consentedAt: '2026-09-30T10:00:00.000Z' },
    });
    consumeActivation(a.code, { userId: 'whatsapp-cloud:972500000001', agentGroupId: 'ag-1' });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      activation_code: a.code,
      policy_version: '2026-09-30',
      consented_at: '2026-09-30T10:00:00.000Z',
      source: 'agent4job',
      user_id: 'whatsapp-cloud:972500000001',
      channel: 'whatsapp-cloud',
    });
    expect(r[0].bound_at).toBeTruthy();
  });

  it('writes nothing when the signup carried no policyVersion', () => {
    const a = createActivation({ lang: 'he', metadata: { src: 'agent4job' } });
    consumeActivation(a.code, { userId: 'telegram-joni:1', agentGroupId: 'ag-1' });
    expect(rows()).toHaveLength(0);
  });

  it('a second consume of the same code does not duplicate the row', () => {
    const a = createActivation({ lang: 'he', metadata: { policyVersion: '2026-09-30' } });
    consumeActivation(a.code, { userId: 'telegram-joni:1', agentGroupId: 'ag-1' });
    expect(consumeActivation(a.code, { userId: 'telegram-joni:2', agentGroupId: 'ag-2' })).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].user_id).toBe('telegram-joni:1');
  });
});
