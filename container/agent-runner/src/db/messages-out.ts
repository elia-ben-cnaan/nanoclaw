/**
 * Outbound message operations (container side).
 *
 * Writes to outbound.db (container-owned).
 * The host polls this DB (read-only) for undelivered messages.
 */
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/** Re-sends within this window of an identical prior send are treated as duplicates. */
const DEDUP_WINDOW = '-60 seconds';

/**
 * Write a new outbound message, auto-assigning an odd seq number.
 * Container uses odd seq (1, 3, 5...), host uses even (2, 4, 6...).
 *
 * The disjoint namespace is load-bearing, not just collision avoidance:
 * seq is the agent-facing message ID returned by send_message and accepted
 * by edit_message / add_reaction, and getMessageIdBySeq() below looks up
 * by seq across BOTH tables. If inbound and outbound could share a seq,
 * the agent's "edit message #5" could resolve to the wrong row.
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();

  // Safety net against duplicate user-visible sends — e.g. the agent being
  // told (possibly wrongly) that its last response "was not delivered" and
  // resending the same content. Same channel/platform/in_reply_to/content
  // within the window is treated as a resend of the same message rather
  // than a new one, and the existing row's seq is returned so callers
  // (send_message, etc.) still get a valid reference.
  const dup = outbound
    .prepare(
      `SELECT seq FROM messages_out
       WHERE channel_type IS $channel_type
         AND platform_id IS $platform_id
         AND in_reply_to IS $in_reply_to
         AND content = $content
         AND timestamp >= datetime('now', $window)
       ORDER BY seq DESC LIMIT 1`,
    )
    .get({
      $channel_type: msg.channel_type ?? null,
      $platform_id: msg.platform_id ?? null,
      $in_reply_to: msg.in_reply_to ?? null,
      $content: msg.content,
      $window: DEDUP_WINDOW,
    }) as { seq: number } | undefined;

  if (dup?.seq != null) {
    console.error(`[messages-out] Skipping duplicate outbound write — matches seq #${dup.seq} within ${DEDUP_WINDOW}`);
    return dup.seq;
  }

  // Read max seq from both DBs to maintain global ordering.
  // Safe: each side only reads the other DB, never writes to it.
  const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const max = Math.max(maxOut, maxIn);
  const nextSeq = max % 2 === 0 ? max + 1 : max + 2; // next odd

  // bun:sqlite requires named parameters to be passed with the prefix character
  // in the JS object keys (better-sqlite3 auto-stripped it, bun:sqlite does not).
  outbound
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES ($id, $seq, $in_reply_to, datetime('now'), $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
    )
    .run({
      $id: msg.id,
      $seq: nextSeq,
      $in_reply_to: msg.in_reply_to ?? null,
      $deliver_after: msg.deliver_after ?? null,
      $recurrence: msg.recurrence ?? null,
      $kind: msg.kind,
      $platform_id: msg.platform_id ?? null,
      $channel_type: msg.channel_type ?? null,
      $thread_id: msg.thread_id ?? null,
      $content: msg.content,
    });

  return nextSeq;
}

/**
 * Look up a message's platform ID by seq number.
 * Searches both inbound and outbound DBs since seq spans both.
 *
 * For inbound messages, the Chat SDK message ID is already the platform message ID
 * (e.g., "6037840640:42" for Telegram).
 *
 * For outbound messages, the internal ID (msg-xxx) won't work for edits/reactions.
 * Instead, look up the platform_message_id from the delivered table (host writes this
 * after successful delivery).
 */
export function getMessageIdBySeq(seq: number): string | null {
  const inbound = getInboundDb();

  // Inbound messages: ID is already the platform message ID
  const inRow = inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (inRow) return inRow.id;

  // Outbound messages: look up platform message ID from delivered table
  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (!outRow) return null;

  // Check if host has stored the platform message ID after delivery
  const deliveredRow = inbound
    .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
    .get(outRow.id) as { platform_message_id: string | null } | undefined;
  if (deliveredRow?.platform_message_id) return deliveredRow.platform_message_id;

  // Fallback to internal ID (edits/reactions on undelivered messages won't work)
  return outRow.id;
}

/**
 * Look up the routing fields for a message by seq (for edit/reaction targeting).
 * Returns the channel_type, platform_id, thread_id of the referenced message.
 */
export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = getInboundDb();
  const inRow = inbound
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (inRow) return inRow;

  const outRow = getOutboundDb()
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  return outRow ?? null;
}

/**
 * Total rows ever written to messages_out this session. Used to detect
 * whether a message was already sent (e.g. via the send_message MCP tool)
 * during the current agent turn, independent of <message to="..."> block
 * parsing — see poll-loop.ts's unwrapped-output nudge.
 */
export function getOutboundCount(): number {
  return (getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
}

/** Highest outbound seq so far — a turn-start marker for same-turn dedup. */
export function getMaxOutboundSeq(): number {
  return (getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
}

/**
 * Was this exact content already delivered to this channel/platform LATER than
 * `sinceSeq`? Used to catch the same-turn double-send: the agent delivers a
 * reply via the send_message MCP tool mid-turn AND then repeats it in a
 * final <message> block. Those two writes get different in_reply_to values
 * (batch vs per-destination re-resolution), so writeMessageOut's in_reply_to-
 * keyed dedup misses them. Scoping to "since this turn started" means a
 * genuine identical reply in a LATER turn (seq below the fresh marker) is not
 * suppressed — no cross-turn over-suppression.
 */
export function wasContentDeliveredSince(
  channelType: string | null,
  platformId: string | null,
  content: string,
  sinceSeq: number,
): boolean {
  const row = getOutboundDb()
    .prepare(
      `SELECT 1 FROM messages_out
       WHERE channel_type IS $channel_type AND platform_id IS $platform_id
         AND content = $content AND seq > $since LIMIT 1`,
    )
    .get({
      $channel_type: channelType ?? null,
      $platform_id: platformId ?? null,
      $content: content,
      $since: sinceSeq,
    });
  return row != null;
}

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}
