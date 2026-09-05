/**
 * Users Board — qualitative cache tests.
 *
 * No network calls: ANTHROPIC_API_KEY is unset in the test environment, so
 * every callHaikuJson() invocation returns null and the module falls back
 * to its deterministic (non-fabricated) summaries. These tests pin that
 * fallback behavior and the cache-hit/cache-miss (content-hash) contract —
 * the parts that don't require a live API key to verify.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./env.js', async () => {
  const actual = await vi.importActual<typeof import('./env.js')>('./env.js');
  return { ...actual, readEnvFile: () => ({}) }; // force "no API key configured"
});

import { initTestDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import {
  getCachedDaySummaries,
  getCachedUserInsights,
  getCachedTopics,
  getCachedAggregate,
  refreshAllSummaries,
} from './users-board-summarize.js';
import type { DayTranscript } from './users-board-data.js';

function day(d: string, userTexts: string[]): DayTranscript {
  return {
    day: d,
    messages: userTexts.map((t, i) => ({ role: 'user' as const, text: t, ms: Date.parse(d + 'T10:0' + i + ':00Z') })),
  };
}

describe('users-board-summarize (no API key — deterministic fallback)', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('day summary falls back to a real count + distilled gist, never invents content', () => {
    const days = [day('2026-08-01', ['תעזור לי לתכנן טיול לפורטוגל בבקשה'])];
    const [summary] = getCachedDaySummaries('ag-1', days);
    expect(summary.fromCache).toBe(false);
    expect(summary.summary).toContain('1 הודעות');
    expect(summary.summary).toContain('תעזור לי לתכנן טיול לפורטוגל');
  });

  it('empty day (agent-only) still returns a truthful summary', () => {
    const days: DayTranscript[] = [{ day: '2026-08-01', messages: [{ role: 'agent', text: 'שלום!', ms: 1 }] }];
    const [summary] = getCachedDaySummaries('ag-1', days);
    expect(summary.summary).toContain('לא הגיב');
  });

  it('user insights fallback: topic from the first real message, everything else null/unknown', () => {
    const days = [day('2026-08-01', ['אני צריך עזרה עם דוח מס'])];
    const insights = getCachedUserInsights('ag-1', days);
    expect(insights.fromCache).toBe(false);
    expect(insights.topic).toContain('דוח מס');
    expect(insights.whatWorks).toBeNull();
    expect(insights.satisfaction).toBe('unknown');
    expect(insights.qualityFlags).toEqual([]);
  });

  it('getCachedTopics / getCachedAggregate return empty state cleanly with nothing cached', () => {
    expect(getCachedTopics().size).toBe(0);
    expect(getCachedAggregate()).toBeNull();
  });

  it('refreshAllSummaries reports hadApiKey=false and does not throw with zero pilots', async () => {
    const result = await refreshAllSummaries();
    expect(result.hadApiKey).toBe(false);
    expect(result.usersProcessed).toBe(0);
    expect(result.daysGenerated).toBe(0);
  });

  it('refreshAllSummaries counts a pilot with no session dirs as processed but generates nothing', async () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Pilot',
      folder: 'pilot-test1',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    // No session dirs on disk → collectDailyTranscript returns [] → nothing to summarize.
    // Exercises the safe no-op path without needing real inbound/outbound DBs.
    const result = await refreshAllSummaries();
    expect(result.usersProcessed).toBe(1);
    expect(result.daysGenerated).toBe(0);
    expect(result.hadApiKey).toBe(false);
  });
});
