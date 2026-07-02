/**
 * Per-turn token usage recorder (display-only metering).
 *
 * Writes one append-only row per provider result into outbound.db's
 * usage_events table. The host reads these read-only when building the
 * operator dashboard. Best-effort by contract: callers wrap this so a
 * metering failure can never break the agent's turn.
 */
import type { TurnUsage } from '../providers/types.js';
import { getOutboundDb } from './connection.js';

export function recordUsage(usage: TurnUsage, model: string | null = null, costUsd = 0): void {
  const id = `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // bun:sqlite needs the `$` prefix in both the SQL and the JS keys.
  getOutboundDb()
    .prepare(
      `INSERT INTO usage_events
         (id, ts, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)
       VALUES ($id, $ts, $model, $in, $out, $cc, $cr, $cost)`,
    )
    .run({
      $id: id,
      $ts: new Date().toISOString(),
      $model: model,
      $in: usage.inputTokens,
      $out: usage.outputTokens,
      $cc: usage.cacheCreationTokens,
      $cr: usage.cacheReadTokens,
      $cost: costUsd,
    });
}
