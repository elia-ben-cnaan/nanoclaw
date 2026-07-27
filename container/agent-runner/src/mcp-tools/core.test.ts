/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message routing regression — reply stays on the origin channel', () => {
  function seedSessionRouting(channelType: string, platformId: string, threadId: string | null) {
    // Host-created table (src/db/schema.ts); the container test schema
    // doesn't include it, so create it here with the same shape.
    getInboundDb().exec(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         channel_type TEXT, platform_id TEXT, thread_id TEXT
       )`,
    );
    getInboundDb()
      .prepare(
        `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, ?, ?, ?)`,
      )
      .run(channelType, platformId, threadId);
  }

  it('default (no `to`) goes back to the session channel, not another destination', async () => {
    seedSessionRouting('telegram', 'telegram:111', 'th-1');
    // A different-channel destination also exists — the default must ignore it.
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-out', 'Slack', 'channel', 'slack', 'C123', NULL)`,
      )
      .run();

    await sendMessage.handler({ text: 'reply in place' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].platform_id).toBe('telegram:111');
    expect(out[0].thread_id).toBe('th-1');
  });

  it('named same-channel destination preserves the session thread', async () => {
    seedSessionRouting('telegram', 'telegram:111', 'th-1');
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('elia', 'Elia', 'channel', 'telegram', 'telegram:111', NULL)`,
      )
      .run();

    await sendMessage.handler({ to: 'elia', text: 'hi' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].thread_id).toBe('th-1');
  });

  it('named cross-channel destination does NOT inherit the session thread', async () => {
    seedSessionRouting('telegram', 'telegram:111', 'th-1');
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-out', 'Slack', 'channel', 'slack', 'C123', NULL)`,
      )
      .run();

    await sendMessage.handler({ to: 'slack-out', text: 'cross' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].thread_id).toBeNull();
  });
});
