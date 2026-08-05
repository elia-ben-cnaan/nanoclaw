/**
 * Turn-stall watchdog — allowance math.
 *
 * The wiring (abort + exit 76 in the poll interval) is deliberately thin;
 * the decision logic lives in turnStallAllowanceMs and is pinned here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import { turnStallAllowanceMs, processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

const BASE = 180_000;
const MARGIN = 60_000;

describe('turnStallAllowanceMs', () => {
  it('no tool in flight → base allowance', () => {
    expect(turnStallAllowanceMs(null, BASE, MARGIN)).toBe(BASE);
  });

  it('tool without a declared timeout → base allowance', () => {
    expect(turnStallAllowanceMs({ declaredTimeoutMs: null }, BASE, MARGIN)).toBe(BASE);
  });

  it('long-declared Bash (10m) widens the allowance to timeout+margin', () => {
    expect(turnStallAllowanceMs({ declaredTimeoutMs: 600_000 }, BASE, MARGIN)).toBe(660_000);
  });

  it('short-declared tool never SHRINKS the allowance below base', () => {
    expect(turnStallAllowanceMs({ declaredTimeoutMs: 5_000 }, BASE, MARGIN)).toBe(BASE);
  });

  it('zero/negative declared timeout is ignored', () => {
    expect(turnStallAllowanceMs({ declaredTimeoutMs: 0 }, BASE, MARGIN)).toBe(BASE);
    expect(turnStallAllowanceMs({ declaredTimeoutMs: -1 }, BASE, MARGIN)).toBe(BASE);
  });
});

describe('turn-stall watchdog — end to end against a wedged provider stream', () => {
  beforeEach(() => {
    initTestSessionDb();
  });
  afterEach(() => {
    closeSessionDb();
    delete process.env.TURN_STALL_TIMEOUT_MS;
  });

  it('a query whose stream goes silent is aborted and the process exit(76) fires within the bound', async () => {
    process.env.TURN_STALL_TIMEOUT_MS = '1200';

    let abortCalled = false;
    let resolveHang: (() => void) | null = null;
    const hangUntilAbort = new Promise<void>((res) => {
      resolveHang = res;
    });

    // Stream that emits one init event, then hangs forever — the exact shape
    // of a wedged SDK subprocess mid-handoff. abort() releases the hang so
    // the generator (and processQuery) can wind down, mirroring the real
    // providers' abort semantics.
    const query: AgentQuery = {
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'stall-test' } as ProviderEvent;
        await hangUntilAbort;
      })(),
      push: () => {},
      end: () => {},
      abort: () => {
        abortCalled = true;
        resolveHang?.();
      },
    };

    // Capture the exit instead of dying: the wiring defers exit by 150ms,
    // so patching process.exit lets the test observe the code.
    const realExit = process.exit;
    let exitCode: number | null = null;
    // @ts-expect-error — test double
    process.exit = (code?: number) => {
      exitCode = code ?? 0;
    };

    try {
      const routing = { platformId: 'test', channelType: 'test', threadId: null } as Parameters<
        typeof processQuery
      >[1];
      const started = Date.now();
      await processQuery(query, routing, [], 'claude', undefined, 'prompt', undefined);
      // Wait out the deferred exit tick.
      await new Promise((r) => setTimeout(r, 400));

      expect(abortCalled).toBe(true);
      expect(exitCode).toBe(76);
      // Recovered within the configured bound (+ interval slack), i.e. the
      // stall did NOT ride to any 30-minute host ceiling.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      process.exit = realExit;
    }
  });
});
