/**
 * Delivery action handler for CLI requests from container agents.
 *
 * When an agent writes a `cli_request` system message to outbound.db,
 * the delivery poll picks it up and calls this handler. We dispatch
 * the command and write the response back to inbound.db.
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import { log } from '../log.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame, ResponseFrame } from './frame.js';
import type { Session } from '../types.js';

const LOOP_WINDOW_MS = parsePositiveInt(process.env.NANOCLAW_CLI_LOOP_WINDOW_MS, 60_000);
const LOOP_MAX_REPEATS = parsePositiveInt(process.env.NANOCLAW_CLI_LOOP_MAX_REPEATS, 12);

type CliLoopEntry = {
  firstSeen: number;
  count: number;
};

const cliLoopEntries = new Map<string, CliLoopEntry>();

const ARG_INSENSITIVE_LOOP_COMMANDS = new Set(['groups-config-get']);
const VOLATILE_ARG_KEYS = new Set([
  'id',
  'requestId',
  'request_id',
  'nonce',
  'timestamp',
  'ts',
  'createdAt',
  'created_at',
]);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeLoopArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeLoopArgs(item));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (VOLATILE_ARG_KEYS.has(key)) continue;
    out[key] = normalizeLoopArgs((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function cliLoopKey(sessionId: string, command: string, args: Record<string, unknown>): string {
  if (ARG_INSENSITIVE_LOOP_COMMANDS.has(command)) return `${sessionId}:${command}:*`;
  return `${sessionId}:${command}:${JSON.stringify(normalizeLoopArgs(args))}`;
}

export function detectCliLoop(
  sessionId: string,
  command: string,
  args: Record<string, unknown>,
  now = Date.now(),
): number {
  const key = cliLoopKey(sessionId, command, args);
  const entry = cliLoopEntries.get(key);
  if (!entry || now - entry.firstSeen > LOOP_WINDOW_MS) {
    cliLoopEntries.set(key, { firstSeen: now, count: 1 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function writeCliResponse(inDb: Database.Database, requestId: string, response: ResponseFrame): void {
  // Write response to inbound.db so the container can read it.
  // trigger=0: don't wake the agent - this is an inline response to a tool call.
  insertMessage(inDb, {
    id: `cli-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({
      type: 'cli_response',
      requestId,
      frame: response,
    }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

registerDeliveryAction('cli_request', async (content, session, inDb) => {
  const requestId = content.requestId as string;
  const command = content.command as string;
  const args = (content.args as Record<string, unknown>) ?? {};

  if (!requestId || !command) {
    log.warn('cli_request missing requestId or command', { sessionId: session.id });
    return;
  }

  const repeatCount = detectCliLoop(session.id, command, args);
  if (repeatCount > LOOP_MAX_REPEATS) {
    const response: ResponseFrame = {
      id: requestId,
      ok: false,
      error: {
        code: 'handler-error',
        message: `Repeated identical CLI request blocked after ${LOOP_MAX_REPEATS} calls in ${LOOP_WINDOW_MS}ms. Stop retrying this command and choose a different diagnostic path.`,
      },
    };
    log.warn('CLI loop detected from agent', { requestId, command, sessionId: session.id, repeatCount });
    writeCliResponse(inDb, requestId, response);
    return;
  }

  const req: RequestFrame = { id: requestId, command, args };
  const ctx = {
    caller: 'agent' as const,
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id ?? '',
  };

  log.info('CLI request from agent', { requestId, command, sessionId: session.id });

  const response = await dispatch(req, ctx);

  writeCliResponse(inDb, requestId, response);

  log.info('CLI response written', { requestId, ok: response.ok, sessionId: session.id });
});
