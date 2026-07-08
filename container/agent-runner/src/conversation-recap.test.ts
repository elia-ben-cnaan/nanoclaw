/**
 * Tests for the cross-provider conversation recap — the bridge over the
 * "two brains" gap when turns move between Claude and Codex.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { buildConversationRecap } from './conversation-recap.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertInbound(id: string, ts: string, sender: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'chat', ?, 'completed', ?)`,
    )
    .run(id, ts, JSON.stringify({ sender, text }));
}

function insertOutbound(id: string, ts: string, text: string): void {
  getOutboundDb()
    .prepare(
      `INSERT INTO messages_out (id, timestamp, kind, content)
       VALUES (?, ?, 'chat', ?)`,
    )
    .run(id, ts, JSON.stringify({ text }));
}

describe('buildConversationRecap', () => {
  it('returns null when there is no conversation at all', () => {
    expect(buildConversationRecap()).toBeNull();
  });

  it('merges user messages and replies from BOTH engines in chronological order', () => {
    insertInbound('m1', '2026-07-08T10:00:00.000Z', 'אליה', 'שאלה ראשונה');
    insertOutbound('o1', '2026-07-08T10:01:00.000Z', 'תשובה מ-Claude');
    insertInbound('m2', '2026-07-08T10:05:00.000Z', 'אליה', 'שאלה שנייה');
    insertOutbound('o2', '2026-07-08T10:06:00.000Z', 'תשובה מ-Codex');

    const recap = buildConversationRecap()!;
    expect(recap).toContain('אליה: שאלה ראשונה');
    expect(recap).toContain('תשובה מ-Claude');
    expect(recap).toContain('תשובה מ-Codex');
    // Chronological: first question appears before the Codex reply.
    expect(recap.indexOf('שאלה ראשונה')).toBeLessThan(recap.indexOf('תשובה מ-Codex'));
    expect(recap.startsWith('<system>')).toBe(true);
    expect(recap.endsWith('</system>')).toBe(true);
  });

  it('sinceIso narrows the recap to the outage period only', () => {
    insertInbound('old', '2026-07-08T09:00:00.000Z', 'אליה', 'לפני ההשבתה');
    insertOutbound('oldR', '2026-07-08T09:01:00.000Z', 'תשובה ישנה');
    insertInbound('new', '2026-07-08T11:00:00.000Z', 'אליה', 'בזמן ההשבתה');
    insertOutbound('newR', '2026-07-08T11:01:00.000Z', 'תשובת codex בהשבתה');

    const recap = buildConversationRecap('2026-07-08T10:30:00.000Z')!;
    expect(recap).toContain('בזמן ההשבתה');
    expect(recap).toContain('תשובת codex בהשבתה');
    expect(recap).not.toContain('לפני ההשבתה');
    expect(recap).not.toContain('תשובה ישנה');
  });

  it('truncates very long messages instead of flooding the prompt', () => {
    insertInbound('m1', '2026-07-08T10:00:00.000Z', 'אליה', 'א'.repeat(2000));
    const recap = buildConversationRecap()!;
    expect(recap).toContain('…');
    expect(recap.length).toBeLessThan(1000);
  });

  it('skips malformed rows without failing the whole recap', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('bad', 'chat', '2026-07-08T10:00:00.000Z', 'completed', 'not-json')`,
      )
      .run();
    insertInbound('good', '2026-07-08T10:01:00.000Z', 'אליה', 'תקין');
    const recap = buildConversationRecap()!;
    expect(recap).toContain('תקין');
  });
});
