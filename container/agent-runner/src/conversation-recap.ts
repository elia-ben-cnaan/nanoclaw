/**
 * Cross-provider conversation recap.
 *
 * Claude and Codex keep SEPARATE conversation threads (separate continuations),
 * so turns served by one engine are invisible to the other: during a quota
 * outage the user's messages land in the Codex thread and Claude never sees
 * them; Codex likewise never sees the Claude turns between outages. Users
 * experience this as the agent "forgetting" mid-conversation ("two brains").
 *
 * The session DBs are the provider-neutral source of truth — every user
 * message is in inbound.db (`messages_in`) and every reply from EITHER engine
 * is in outbound.db (`messages_out`). This module rebuilds a short recap from
 * those rows so the poll-loop can inject it at the two engine-switch
 * boundaries (switch to fallback, recovery back to primary).
 */
import { getInboundDb, getOutboundDb } from './db/connection.js';

const MAX_LINES = 12;
const MAX_LINE_CHARS = 300;

interface RecapLine {
  ts: string;
  who: string;
  text: string;
}

function parseInboundLine(row: { timestamp: string; content: string }): RecapLine | null {
  try {
    const c = JSON.parse(row.content) as { sender?: string; text?: string };
    if (!c.text) return null;
    return { ts: row.timestamp, who: c.sender || 'user', text: c.text };
  } catch {
    return null;
  }
}

function parseOutboundLine(row: { timestamp: string; content: string }): RecapLine | null {
  try {
    const c = JSON.parse(row.content) as { text?: string };
    if (!c.text) return null;
    return { ts: row.timestamp, who: 'you (assistant)', text: c.text };
  } catch {
    return null;
  }
}

/**
 * Build a `<system>` recap block of the recent conversation, merged across
 * both engines from the session DBs. `sinceIso` narrows it to exchanges after
 * a given time (e.g. the start of an outage — exactly the turns the returning
 * engine missed); without it, the most recent exchanges overall are used.
 * Returns null when there is nothing to recap.
 */
export function buildConversationRecap(sinceIso?: string): string | null {
  const lines: RecapLine[] = [];

  try {
    const inRows = (
      sinceIso
        ? getInboundDb()
            .prepare(
              `SELECT timestamp, content FROM messages_in
               WHERE kind IN ('chat','chat-sdk') AND timestamp >= ?
               ORDER BY seq DESC LIMIT ?`,
            )
            .all(sinceIso, MAX_LINES)
        : getInboundDb()
            .prepare(
              `SELECT timestamp, content FROM messages_in
               WHERE kind IN ('chat','chat-sdk')
               ORDER BY seq DESC LIMIT ?`,
            )
            .all(MAX_LINES)
    ) as Array<{ timestamp: string; content: string }>;
    for (const r of inRows) {
      const line = parseInboundLine(r);
      if (line) lines.push(line);
    }
  } catch {
    // Recap is best-effort — a read failure must never break the turn.
  }

  try {
    const outRows = (
      sinceIso
        ? getOutboundDb()
            .prepare(
              `SELECT timestamp, content FROM messages_out
               WHERE kind = 'chat' AND timestamp >= ?
               ORDER BY seq DESC LIMIT ?`,
            )
            .all(sinceIso, MAX_LINES)
        : getOutboundDb()
            .prepare(
              `SELECT timestamp, content FROM messages_out
               WHERE kind = 'chat'
               ORDER BY seq DESC LIMIT ?`,
            )
            .all(MAX_LINES)
    ) as Array<{ timestamp: string; content: string }>;
    for (const r of outRows) {
      const line = parseOutboundLine(r);
      if (line) lines.push(line);
    }
  } catch {
    // Best-effort, as above.
  }

  if (lines.length === 0) return null;

  lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = lines.slice(-MAX_LINES);

  const body = recent
    .map((l) => {
      const text = l.text.length > MAX_LINE_CHARS ? `${l.text.slice(0, MAX_LINE_CHARS)}…` : l.text;
      return `[${l.ts.slice(11, 16)}] ${l.who}: ${text}`;
    })
    .join('\n');

  return (
    `<system>Conversation recap (auto-injected at engine switch). Recent turns may have been served ` +
    `by a different engine, so your own thread may be missing them:\n${body}\n` +
    `Continue the conversation naturally from this context. Do not mention the engine switch or this recap unless asked.</system>`
  );
}
