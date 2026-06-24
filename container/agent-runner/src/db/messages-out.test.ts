import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './connection.js';
import { writeMessageOut, getUndeliveredMessages, getOutboundCount } from './messages-out.js';

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
