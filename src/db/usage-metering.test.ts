import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from './index.js';
import { dailyCostAction } from './usage-metering.js';

const AG = 'pilot-costpolicy';

function dayStr(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// Seed a usage_daily row whose Haiku-priced cost equals `costUsd` (output @ $5/1M).
function seedDay(day: string, costUsd: number): void {
  const outTokens = Math.round((costUsd / 5) * 1_000_000);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO usage_daily
         (agent_group_id, day, in_tokens, out_tokens, cache_creation_tokens, cache_read_tokens, model, updated_at)
       VALUES (?, ?, 0, ?, 0, 0, 'claude-haiku-4-5', ?)`,
    )
    .run(AG, day, outTokens, new Date().toISOString());
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // $1.00/day cap for the test agent.
  db.prepare('INSERT OR REPLACE INTO agent_cost_caps (agent_group_id, cap_usd, updated_at) VALUES (?, ?, ?)').run(
    AG,
    1.0,
    new Date().toISOString(),
  );
});

afterEach(() => {
  closeDb();
});

describe('dailyCostAction — graduated pilot daily-cost policy', () => {
  it("returns 'ok' when today is under the cap", () => {
    seedDay(dayStr(0), 0.1);
    seedDay(dayStr(-1), 0.1);
    expect(dailyCostAction(AG)).toBe('ok');
  });

  it("returns 'downgrade' on the first day over the cap (yesterday under)", () => {
    seedDay(dayStr(0), 2.0);
    seedDay(dayStr(-1), 0.1);
    expect(dailyCostAction(AG)).toBe('downgrade');
  });

  it("returns 'block' on the second consecutive day over the cap", () => {
    seedDay(dayStr(0), 2.0);
    seedDay(dayStr(-1), 2.0);
    expect(dailyCostAction(AG)).toBe('block');
  });
});

describe('daily-quota notices — ratio + once-per-day claim', () => {
  it('dailyCostRatio reflects spend/cap', async () => {
    const { dailyCostRatio } = await import('./usage-metering.js');
    seedDay(dayStr(0), 0.5);
    expect(dailyCostRatio(AG)).toBeCloseTo(0.5, 2);
    seedDay(dayStr(0), 0.95);
    expect(dailyCostRatio(AG)).toBeGreaterThanOrEqual(0.9);
  });

  it('claimCostNotice fires once per (agent, day, level)', async () => {
    const { claimCostNotice } = await import('./usage-metering.js');
    expect(claimCostNotice(AG, 'approaching')).toBe(true);
    expect(claimCostNotice(AG, 'approaching')).toBe(false); // deduped
    expect(claimCostNotice(AG, 'exhausted')).toBe(true); // different level still fires
    expect(claimCostNotice(AG, 'exhausted')).toBe(false);
    expect(claimCostNotice('other-agent', 'approaching')).toBe(true); // per-agent
  });
});
