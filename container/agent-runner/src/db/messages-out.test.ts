import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './connection.js';
import {
  writeMessageOut,
  getUndeliveredMessages,
  getOutboundCount,
  getMaxOutboundSeq,
  wasContentDeliveredSince,
} from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('writeMessageOut dedup', () => {
  it('skips a second identical send within the dedup window and returns the original seq', () => {
    const first = writeMessageOut({
      id: 'm1',
      in_reply_to: 'in-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
    });

    const second = writeMessageOut({
      id: 'm2', // different internal id — a resend, not a retried write of the same row
      in_reply_to: 'in-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
    });

    expect(second).toBe(first);
    expect(getOutboundCount()).toBe(1);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('does not dedup messages with different content', () => {
    writeMessageOut({
      id: 'm1',
      in_reply_to: 'in-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
    });
    writeMessageOut({
      id: 'm2',
      in_reply_to: 'in-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'goodbye' }),
    });

    expect(getOutboundCount()).toBe(2);
  });

  it('does not dedup messages to a different destination', () => {
    writeMessageOut({
      id: 'm1',
      in_reply_to: 'in-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
    });
    writeMessageOut({
      id: 'm2',
      in_reply_to: 'in-1',
      kind: 'chat',
      platform_id: 'chan-2',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
    });

    expect(getOutboundCount()).toBe(2);
  });
});

describe('wasContentDeliveredSince — same-turn duplicate detection', () => {
  const send = (id: string, inReplyTo: string | null, text: string) =>
    writeMessageOut({
      id,
      in_reply_to: inReplyTo,
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'telegram',
      content: JSON.stringify({ text }),
    });

  it('detects a repeat of content sent since the turn marker — even with a DIFFERENT in_reply_to', () => {
    const turnStart = getMaxOutboundSeq();
    // The send_message MCP tool writes with the batch in_reply_to (null here).
    send('viaTool', null, 'הלוגו עלה');
    const content = JSON.stringify({ text: 'הלוגו עלה' });
    // The final <message> block would write the SAME text with a real
    // in_reply_to — this is exactly the pair that writeMessageOut's own dedup
    // misses. The turn-scoped check catches it.
    expect(wasContentDeliveredSince('telegram', 'chan-1', content, turnStart)).toBe(true);
  });

  it('does NOT flag an identical reply from a PRIOR turn (no cross-turn over-suppression)', () => {
    send('turn1', 'in-1', 'כן');
    // A new turn starts — its marker is above turn 1's row.
    const turn2Start = getMaxOutboundSeq();
    const content = JSON.stringify({ text: 'כן' });
    expect(wasContentDeliveredSince('telegram', 'chan-1', content, turn2Start)).toBe(false);
  });

  it('does not flag content that was never sent', () => {
    const turnStart = getMaxOutboundSeq();
    send('x', null, 'something');
    expect(wasContentDeliveredSince('telegram', 'chan-1', JSON.stringify({ text: 'other' }), turnStart)).toBe(false);
  });

  it('catches a whitespace-only retype — the real missed pair (space before \\n\\n)', () => {
    // Modeled on live pair 21803/21805: the agent RETYPED the reply in the
    // final <message> block and the only difference was a single space
    // before a "\n\n" mid-text. Byte equality missed it; normalization must not.
    const turnStart = getMaxOutboundSeq();
    send('viaTool', null, 'אני כאן! ההודעה שלי אולי לא הגיעה בזמן. \n\nשאלתי: להחליף את האייקון?');
    const retyped = JSON.stringify({ text: 'אני כאן! ההודעה שלי אולי לא הגיעה בזמן.\n\nשאלתי: להחליף את האייקון?' });
    expect(wasContentDeliveredSince('telegram', 'chan-1', retyped, turnStart)).toBe(true);
  });

  it('does NOT flag a semantically different reply in the same turn', () => {
    const turnStart = getMaxOutboundSeq();
    send('viaTool', null, 'הלוגו עלה בהצלחה');
    const different = JSON.stringify({ text: 'הלוגו עלה בהצלחה — רוצה שאשנה גם את הפונט?' });
    expect(wasContentDeliveredSince('telegram', 'chan-1', different, turnStart)).toBe(false);
  });
});
