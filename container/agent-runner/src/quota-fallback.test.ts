/**
 * Tests for the quota-fallback flow: quota-error detection and the
 * single-turn fallback runner that retries an unanswered prompt on the
 * overflow provider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation, setContinuation, loadFallbackState, saveFallbackState } from './db/session-state.js';
import { isQuotaErrorMessage, QuotaExhaustedError } from './quota.js';
import {
  runFallbackTurn,
  newFallbackState,
  isPrimaryInCooldown,
  registerPrimaryQuota,
  registerPrimaryRecovery,
  classifyFallbackFailure,
} from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import type { Database } from 'bun:sqlite';

const ROUTING = {
  platformId: 'whatsapp:123',
  channelType: 'whatsapp',
  threadId: null,
  inReplyTo: null,
};

let inbound: Database;

beforeEach(() => {
  ({ inbound } = initTestSessionDb());
  inbound
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('user', 'User', 'channel', 'whatsapp', 'whatsapp:123')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

/** Minimal scripted provider: plays a fixed event sequence per query. */
function scriptedProvider(events: ProviderEvent[], onQuery?: (input: QueryInput) => void): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query(input: QueryInput): AgentQuery {
      onQuery?.(input);
      let ended = false;
      return {
        push() {},
        end() {
          ended = true;
        },
        abort() {
          ended = true;
        },
        events: (async function* () {
          for (const e of events) {
            if (ended) return;
            yield e;
          }
        })(),
      };
    },
  };
}

describe('isQuotaErrorMessage', () => {
  it('matches real quota/limit error shapes', () => {
    expect(isQuotaErrorMessage('Claude AI usage limit reached|1783240000')).toBe(true);
    expect(isQuotaErrorMessage('429 {"type":"rate_limit_error"}')).toBe(true);
    expect(isQuotaErrorMessage('Your credit balance is too low to access the API')).toBe(true);
    expect(isQuotaErrorMessage('quota exceeded for this billing period')).toBe(true);
    // Confirmed live on daniela's server 2026-07-06 — this is what a
    // subscription session-limit hit actually looks like, and it arrives
    // as a normal (non-error) result, not an SDK error.
    expect(isQuotaErrorMessage("You've hit your session limit · resets 7:30am (UTC)")).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isQuotaErrorMessage('No conversation found with session ID abc')).toBe(false);
    expect(isQuotaErrorMessage('fetch failed: ETIMEDOUT')).toBe(false);
  });

  it('treats a non-zero Claude Code process exit as fallback-eligible', () => {
    // The subprocess sometimes dies before propagating the underlying quota
    // response. With Codex configured as overflow, this must retry the user
    // message instead of leaving the agent stuck.
    expect(isQuotaErrorMessage('Claude Code process exited with code 1')).toBe(true);
    expect(isQuotaErrorMessage('Claude Code process exited with code 0')).toBe(false);
  });
});

describe('QuotaExhaustedError', () => {
  it('carries the unanswered prompt for the fallback retry', () => {
    const err = new QuotaExhaustedError('usage limit reached', '<messages>hello</messages>');
    expect(err.lastPrompt).toBe('<messages>hello</messages>');
    expect(err.name).toBe('QuotaExhaustedError');
  });
});

describe('runFallbackTurn', () => {
  const fallbackOf = (p: AgentProvider) => ({ provider: p, providerName: 'codex' });

  it('delivers the fallback result and persists the fallback continuation', async () => {
    const provider = scriptedProvider([
      { type: 'init', continuation: 'codex-thread-1' },
      { type: 'result', text: '<message to="user">תשובה ממנוע הגיבוי</message>' },
    ]);

    await runFallbackTurn(fallbackOf(provider), 'prompt-text', ROUTING, '/workspace/agent');

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('תשובה ממנוע הגיבוי');
    expect(getContinuation('codex')).toBe('codex-thread-1');
  });

  it('resumes the fallback conversation from its own stored continuation', async () => {
    let seenContinuation: string | undefined;
    const provider = scriptedProvider(
      [
        { type: 'init', continuation: 'codex-thread-2' },
        { type: 'result', text: '<message to="user">ok</message>' },
      ],
      (input) => {
        seenContinuation = input.continuation;
      },
    );

    // First turn stores the continuation; second turn must receive it.
    await runFallbackTurn(fallbackOf(provider), 'first', ROUTING, '/workspace/agent');
    await runFallbackTurn(fallbackOf(provider), 'second', ROUTING, '/workspace/agent');
    expect(seenContinuation).toBe('codex-thread-2');
  });

  it('throws when the fallback provider is also out of quota', async () => {
    const provider = scriptedProvider([
      { type: 'error', message: '429 rate limit', retryable: false, classification: 'quota' },
    ]);

    await expect(runFallbackTurn(fallbackOf(provider), 'prompt', ROUTING, '/workspace/agent')).rejects.toThrow(
      /quota exhausted/i,
    );
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('never silently drops output: raw-delivers when Codex-as-fallback never wraps, even after the nudge', async () => {
    // The exact "goes silent after quota fallback" bug: Codex's final text
    // isn't reliably wrapped in <message to="..."> blocks. Script two
    // consecutive unwrapped results — the nudge fires once, and even though
    // the retry ALSO comes back unwrapped, the raw text must still reach the
    // user instead of vanishing.
    const provider = scriptedProvider([
      { type: 'init', continuation: 'codex-thread-3' },
      { type: 'result', text: 'first bare reply, no envelope' },
      { type: 'result', text: 'still bare after the nudge — Codex never wraps' },
    ]);

    await runFallbackTurn(fallbackOf(provider), 'prompt-text', ROUTING, '/workspace/agent');

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('still bare after the nudge — Codex never wraps');
    expect(out[0].platform_id).toBe(ROUTING.platformId);
    expect(out[0].channel_type).toBe(ROUTING.channelType);
  });

  it('throws when the fallback stream ends without any result', async () => {
    const provider = scriptedProvider([{ type: 'init', continuation: 'x' }]);

    await expect(runFallbackTurn(fallbackOf(provider), 'prompt', ROUTING, '/workspace/agent')).rejects.toThrow(
      /no result/i,
    );
  });

  it('self-heals a stuck fallback thread — clears it and retries on a fresh thread', async () => {
    setContinuation('codex', 'stuck-thread'); // a poisoned resume id, as after a freeze

    let attempts = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: (err) => /thread not found/i.test(err instanceof Error ? err.message : String(err)),
      query(input) {
        attempts++;
        const resuming = input.continuation === 'stuck-thread';
        const events: ProviderEvent[] = resuming
          ? [{ type: 'error', message: 'thread not found', retryable: false }]
          : [
              { type: 'init', continuation: 'fresh-thread' },
              { type: 'result', text: '<message to="user">healed</message>' },
            ];
        let ended = false;
        return {
          push() {},
          end() {
            ended = true;
          },
          abort() {
            ended = true;
          },
          events: (async function* () {
            for (const e of events) {
              if (ended) return;
              yield e;
            }
          })(),
        };
      },
    };

    await runFallbackTurn({ provider, providerName: 'codex' }, 'prompt', ROUTING, '/workspace/agent');

    expect(attempts).toBe(2); // resumed (failed) then fresh
    expect(getContinuation('codex')).toBe('fresh-thread'); // stuck cleared, fresh persisted
    const texts = getUndeliveredMessages().map((r) => JSON.parse(r.content).text);
    expect(texts).toContain('healed');
  });

  it('does NOT nuke a good thread on a transient (non-stale) fallback error', async () => {
    setContinuation('codex', 'good-thread');
    // Resuming errors transiently (not a stale-thread signal) and yields no result.
    const provider = scriptedProvider([{ type: 'error', message: 'network blip', retryable: true }]);

    await expect(
      runFallbackTurn({ provider, providerName: 'codex' }, 'prompt', ROUTING, '/workspace/agent'),
    ).rejects.toThrow();
    // Continuity preserved — only stale-thread signals trigger a reset.
    expect(getContinuation('codex')).toBe('good-thread');
  });
});

describe('classifyFallbackFailure', () => {
  it('identifies auth failures from the Codex linked-desktop path', () => {
    expect(classifyFallbackFailure('External ChatGPT authorization expired')).toBe('auth');
    expect(classifyFallbackFailure('Linked desktop authorization needs an updated access-token snapshot')).toBe('auth');
  });

  it('separates quota, stale thread, and network failures', () => {
    expect(classifyFallbackFailure('429 rate limit')).toBe('quota');
    expect(classifyFallbackFailure('thread not found')).toBe('stale-thread');
    expect(classifyFallbackFailure('fetch failed: ETIMEDOUT')).toBe('network');
  });
});

describe('quota-fallback outage state machine', () => {
  const T0 = 1_000_000; // arbitrary fixed "now" — no real clock, fully deterministic
  const COOLDOWN_MS = 10 * 60 * 1000;

  it('announces the switch once per outage, not once per message', () => {
    const s = newFallbackState();

    // First quota hit of the outage → announce.
    expect(registerPrimaryQuota(s, T0).announce).toBe(true);
    // Every subsequent quota hit while still down → stay silent.
    expect(registerPrimaryQuota(s, T0 + 1_000).announce).toBe(false);
    expect(registerPrimaryQuota(s, T0 + 5_000).announce).toBe(false);
  });

  it('opens and keeps extending the primary cooldown on repeated quota hits', () => {
    const s = newFallbackState();

    registerPrimaryQuota(s, T0);
    // Inside the window → skip the primary (only when a fallback exists).
    expect(isPrimaryInCooldown(s, true, T0 + COOLDOWN_MS - 1)).toBe(true);
    // No fallback configured → never skip the primary, even mid-cooldown.
    expect(isPrimaryInCooldown(s, false, T0 + COOLDOWN_MS - 1)).toBe(false);
    // Past the window → probe the primary again.
    expect(isPrimaryInCooldown(s, true, T0 + COOLDOWN_MS + 1)).toBe(false);

    // A later quota hit refreshes the window from the new "now".
    registerPrimaryQuota(s, T0 + COOLDOWN_MS + 1);
    expect(isPrimaryInCooldown(s, true, T0 + COOLDOWN_MS + 2)).toBe(true);
  });

  it('sends the recovery notice once when the primary comes back, then goes quiet', () => {
    const s = newFallbackState();
    registerPrimaryQuota(s, T0);

    // Primary succeeds → notify return exactly once and clear the cooldown.
    const first = registerPrimaryRecovery(s);
    expect(first.notifyReturn).toBe(true);
    expect(isPrimaryInCooldown(s, true, T0 + 1)).toBe(false);

    // Further successes while already recovered → no repeat notice.
    expect(registerPrimaryRecovery(s).notifyReturn).toBe(false);
  });

  it('never announces recovery if no switch was ever announced', () => {
    const s = newFallbackState();
    expect(registerPrimaryRecovery(s).notifyReturn).toBe(false);
  });
});

describe('fallback state persistence (survives container restart)', () => {
  it('round-trips onFallback + cooldown through the session store', () => {
    expect(loadFallbackState()).toBeUndefined(); // fresh session — nothing stored

    const s = newFallbackState();
    registerPrimaryQuota(s, 1_000_000);
    saveFallbackState(s);

    // A restart re-reads the same outage state instead of starting clean.
    const restored = loadFallbackState();
    expect(restored).toEqual({
      onFallback: true,
      primaryCooldownUntil: 1_000_000 + 10 * 60 * 1000,
      outageStartedAt: 1_000_000,
    });
  });

  it('persists recovery so a restart after recovery does not think it is still down', () => {
    const s = newFallbackState();
    registerPrimaryQuota(s, 1_000_000);
    saveFallbackState(s);
    registerPrimaryRecovery(s);
    saveFallbackState(s);

    expect(loadFallbackState()).toEqual({ onFallback: false, primaryCooldownUntil: 0, outageStartedAt: 0 });
  });

  it('tracks the outage start for the recovery recap: set on first hit, kept on repeats, cleared on recovery', () => {
    const s = newFallbackState();
    registerPrimaryQuota(s, 1_000_000);
    expect(s.outageStartedAt).toBe(1_000_000);
    registerPrimaryQuota(s, 1_500_000); // still the SAME outage — keep the original start
    expect(s.outageStartedAt).toBe(1_000_000);
    registerPrimaryRecovery(s);
    expect(s.outageStartedAt).toBe(0);
  });
});

describe('codex thread rotation (bloated-thread wedge regression)', () => {
  // Live failure: a ~715K-token fallback thread made every resume+compact
  // cycle outlast the host watchdog — fallback never answered. The provider
  // must refuse to resume a thread whose rollout transcript is oversized.
  it('maybeRotateContinuation flags an oversized rollout and keeps a small one', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { CodexProvider, findRolloutPath } = await import('./providers/codex.js');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rotate-'));
    const day = path.join(home, '.codex', 'sessions', '2026', '07', '27');
    fs.mkdirSync(day, { recursive: true });
    const bigId = '0199-big-thread';
    const smallId = '0199-small-thread';
    // 1.4MB = the size of the rollout that wedged live (compaction outlived
    // the watchdog) — the cap must catch it, not just comfortably-huge files.
    fs.writeFileSync(path.join(day, `rollout-x-${bigId}.jsonl`), Buffer.alloc(Math.round(1.4 * 1024 * 1024), 0x61));
    fs.writeFileSync(path.join(day, `rollout-x-${smallId}.jsonl`), Buffer.alloc(512 * 1024, 0x61));

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(findRolloutPath(bigId)).toContain(bigId);
      const provider = new CodexProvider({});
      expect(provider.maybeRotateContinuation(bigId)).toContain('cap');
      expect(provider.maybeRotateContinuation(smallId)).toBeNull();
      // Unknown thread (no rollout on disk) must not rotate — server may still know it.
      expect(provider.maybeRotateContinuation('no-such-thread')).toBeNull();
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('fallback turn rotates an oversized continuation before resuming', () => {
  it('runFallbackTurn clears and does not resume a rotated thread', async () => {
    const { runFallbackTurn } = await import('./poll-loop.js');
    const { setContinuation, getContinuation } = await import('./db/session-state.js');

    setContinuation('rot-fb', 'stale-big-thread');

    const resumedWith: Array<string | undefined> = [];
    const provider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      maybeRotateContinuation: () => 'rollout 5.0MB > 4MB cap',
      query(input: { continuation?: string }) {
        resumedWith.push(input.continuation);
        let ended = false;
        return {
          push() {},
          end() {
            ended = true;
          },
          abort() {},
          events: (async function* () {
            yield { type: 'init', continuation: 'fresh-thread' };
            yield { type: 'result', text: '<message to="elia">ok</message>' };
            while (!ended) await new Promise((r) => setTimeout(r, 5));
          })(),
        };
      },
    };

    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('elia', 'Elia', 'channel', 'telegram', 'telegram:1', NULL)`,
      )
      .run();

    await runFallbackTurn(
      { provider: provider as never, providerName: 'rot-fb' },
      'prompt',
      { platformId: 'telegram:1', channelType: 'telegram', threadId: null, inReplyTo: null },
      '/tmp',
    );

    // The stale thread must NOT be passed to query(); a fresh one is stored.
    expect(resumedWith).toEqual([undefined]);
    expect(getContinuation('rot-fb')).toBe('fresh-thread');
  });
});
