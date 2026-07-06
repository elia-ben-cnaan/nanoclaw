/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

const FALLBACK_STATE_KEY = 'fallback_state';

/**
 * Persisted quota-fallback outage state. Kept on disk (not just in the loop's
 * memory) so a container restart mid-outage — e.g. the host watchdog bouncing
 * us — resumes the same state instead of re-announcing the switch to the user.
 */
export interface PersistedFallbackState {
  onFallback: boolean;
  primaryCooldownUntil: number;
}

export function loadFallbackState(): PersistedFallbackState | undefined {
  const raw = getValue(FALLBACK_STATE_KEY);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedFallbackState>;
    if (typeof parsed?.onFallback === 'boolean' && typeof parsed?.primaryCooldownUntil === 'number') {
      return { onFallback: parsed.onFallback, primaryCooldownUntil: parsed.primaryCooldownUntil };
    }
  } catch {
    // Corrupt/legacy row — ignore and start from a clean outage state.
  }
  return undefined;
}

export function saveFallbackState(state: PersistedFallbackState): void {
  setValue(FALLBACK_STATE_KEY, JSON.stringify(state));
}

const RATE_LIMIT_WARNED_KEY = 'rate_limit_warned_resets_at';

/**
 * The `resetsAt` of the rate-limit window we've already sent a proactive
 * "nearing the limit" warning for. Used to send that heads-up at most once per
 * window (and survive restarts). `undefined` = no warning sent yet.
 */
export function getRateLimitWarnedAt(): number | undefined {
  const raw = getValue(RATE_LIMIT_WARNED_KEY);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function setRateLimitWarnedAt(resetsAt: number): void {
  setValue(RATE_LIMIT_WARNED_KEY, String(resetsAt));
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}
