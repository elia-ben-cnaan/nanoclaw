/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, native compaction, and
 * stable MCP config via ~/.codex/config.toml — which is the same mechanism
 * the standalone codex CLI uses, so the container and host share one
 * provider-integration story.
 *
 * Codex turns don't accept mid-turn input. Follow-up `push()` messages are
 * queued and drained after the current turn completes (same pattern as the
 * opencode provider — see poll-loop for why that's correct: the poll-loop
 * only pushes once it has new pending messages, and we only drain between
 * turns, so no message is dropped).
 */
import fs from 'fs';

import { type MemorySessionHookRegistration, memoryContextForSessionStart } from '../memory/session-hook.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type JsonRpcNotification,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  killCodexAppServer,
  sendCodexRequest,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

/** Cumulative input tokens before triggering native compaction. */
const COMPACT_THRESHOLD = 40_000;

/** Hard ceiling for a single turn. Guards against app-server wedging. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hard ceiling for a between-turns thread/compact request. Compaction of a
 * bloated thread can hang far past the host's heartbeat ceiling (no events
 * flow during it, so the heartbeat goes stale and the watchdog kills the
 * container mid-fallback — seen live on a ~715K-token thread). Bounded so a
 * slow compaction degrades to "continue uncompacted" instead of a dead turn.
 */
const COMPACT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Rollout transcript size past which a stored thread is dropped instead of
 * resumed. A thread this size makes every resume+compact cycle slower than
 * the watchdog allows; a fresh thread (the poll-loop prepends a recap) is
 * strictly better than a wedge. Calibrated from a live wedge: a 1.36MB
 * rollout resumed into a ~715K-token turn context whose compaction outlived
 * the 30-min heartbeat ceiling — so the cap sits below that, not at a
 * comfortable-sounding round number.
 */
const THREAD_ROTATE_BYTES = 1 * 1024 * 1024;

/**
 * Errors that indicate the stored thread ID is unusable — typically
 * because the app-server has no memory of it (thread transcript was
 * deleted, server was wiped, ID is from a different codex version).
 */
const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

// ── System-prompt assembly ──────────────────────────────────────────────────
// Codex's app-server doesn't read CLAUDE.md/AGENT.md from cwd the way Claude
// Code does. We have to load it and pass it in as `baseInstructions`. The
// addendum from the poll-loop (destinations syntax, etc.) is appended.

/**
 * Locate the rollout .jsonl for a thread id under ~/.codex/sessions
 * (layout: sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl).
 * Exported for tests.
 */
export function findRolloutPath(threadId: string, sessionsRoot?: string): string | null {
  const root = sessionsRoot ?? `${process.env.CODEX_HOME || `${process.env.HOME || '/home/node'}/.codex`}/sessions`;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) stack.push(full);
      else if (e.name.includes(threadId) && e.name.endsWith('.jsonl')) return full;
    }
  }
  return null;
}

function loadAgentBaseInstructions(): string | undefined {
  const candidates = ['/workspace/agent/CLAUDE.md', '/workspace/agent/AGENT.md'];
  const parts: string[] = [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      parts.push(fs.readFileSync(p, 'utf-8'));
      break;
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** Exported for tests. `memoryContext` is set only when a NEW thread starts. */
export function composeBaseInstructions(
  promptAddendum: string | undefined,
  memoryContext?: string,
): string | undefined {
  const agentMd = loadAgentBaseInstructions();
  const pieces = [agentMd, promptAddendum, memoryContext].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private readonly model: string | undefined;
  private readonly baseUrl?: string;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    // Per-group model wins (the group's `model` config, for agents whose
    // PRIMARY provider is codex — e.g. a dedicated dev agent). The global
    // CODEX_MODEL env is the quota-fallback default: index.ts creates the
    // fallback codex with model:undefined, so a claude group's fallback lands
    // here and uses CODEX_MODEL, never its (claude) model field.
    this.model = options.env?.NANOCLAW_CODEX_AUTH === 'chatgpt'
      ? options.model
      : options.model ?? (options.env?.CODEX_MODEL as string | undefined) ?? 'gpt-5.4-mini';
    // Subscription auth must use Codex's native ChatGPT route, never an
    // API-compatible base URL supplied for the OneCLI/API fallback path.
    this.baseUrl = options.env?.NANOCLAW_CODEX_AUTH === 'chatgpt'
      ? undefined
      : options.env?.OPENAI_BASE_URL as string | undefined;
  }

  /**
   * Codex's app-server has no session-start hook mechanism, so shared memory
   * is wired through `baseInstructions` instead: when a query starts a NEW
   * thread (no continuation), the memory context is appended to the base
   * instructions. Resuming an existing thread injects nothing — that context
   * already carries it — matching the hook's 'resume' semantics on Claude.
   */
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  /**
   * Drop a thread whose on-disk rollout transcript has grown past the rotate
   * cap. Resume works by thread id (not file path), so rotation here is just
   * "don't resume" — the caller clears the continuation and starts fresh.
   */
  maybeRotateContinuation(continuation: string): string | null {
    const rolloutPath = findRolloutPath(continuation);
    if (!rolloutPath) return null;
    let size: number;
    try {
      size = fs.statSync(rolloutPath).size;
    } catch {
      return null;
    }
    if (size <= THREAD_ROTATE_BYTES) return null;
    return `rollout ${(size / 1_048_576).toFixed(1)}MB > ${(THREAD_ROTATE_BYTES / 1_048_576).toFixed(0)}MB cap`;
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Codex memory session hook was not registered');
    // New thread → fresh context window → inject memory (startup semantics).
    // Resume carries the previous context, which already includes it.
    const memoryContext = input.continuation ? undefined : memoryContextForSessionStart('startup');
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const kick = (): void => {
      waiting?.();
    };

    pending.push(input.prompt);

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      writeCodexMcpConfigToml(self.mcpServers);
      const server = spawnCodexAppServer(createCodexConfigOverrides(self.baseUrl));
      attachCodexAutoApproval(server);

      let threadId: string | undefined = input.continuation;
      let initYielded = false;
      let cumulativeInputTokens = 0;

      try {
        await initializeCodexAppServer(server);

        const threadParams = {
          model: self.model,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(input.systemContext?.instructions, memoryContext),
        };

        threadId = await startOrResumeCodexThread(server, threadId, threadParams);

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const text = pending.shift()!;

          // One turn = one channel of streaming events. Each notification
          // from the app-server yields an `activity` first (so the
          // poll-loop's idle timer stays honest) and then, where relevant,
          // an init / result / progress event.
          const totalBeforeTurn = cumulativeInputTokens;
          yield* runOneTurn(
            server,
            threadId!,
            text,
            self.model,
            input.cwd,
            () => initYielded,
            () => {
              initYielded = true;
            },
            (tokens) => {
              cumulativeInputTokens = tokens;
            },
          );

          // Trigger native compaction between turns when the CURRENT context
          // has grown past the threshold. The app-server reports the thread's
          // LIFETIME total input tokens, which only ever grows — comparing it
          // directly to the threshold meant that once a thread had ever
          // crossed 40k lifetime tokens, EVERY turn compacted forever (seen
          // live at 23M lifetime tokens, compacting each turn and squashing
          // conversational detail every time). The per-turn delta of the
          // lifetime total ≈ the tokens fed into this turn ≈ current context
          // size — that's the signal compaction should key on.
          const turnContextTokens = cumulativeInputTokens - totalBeforeTurn;
          if (turnContextTokens >= COMPACT_THRESHOLD && threadId) {
            log(`Compacting thread (turn context ~${turnContextTokens} tokens)`);
            const compactResp = await Promise.race([
              sendCodexRequest(server, 'thread/compact/start', { threadId }),
              new Promise<{ error: { message: string } }>((resolve) =>
                setTimeout(
                  () => resolve({ error: { message: `compaction timed out after ${COMPACT_TIMEOUT_MS / 1000}s` } }),
                  COMPACT_TIMEOUT_MS,
                ),
              ),
            ]);
            if (compactResp.error) {
              log(`Compaction failed: ${compactResp.error.message} — continuing uncompacted`);
            } else {
              log('Native compaction completed');
            }
          }
        }
      } finally {
        killCodexAppServer(server);
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        aborted = true;
        kick();
      },
      events: gen(),
    };
  }
}

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string | undefined,
  cwd: string,
  hasInit: () => boolean,
  markInit: () => void,
  setInputTokens: (n: number) => void,
): AsyncGenerator<ProviderEvent> {
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  const turnState: { error: Error | null } = { error: null };
  let resultText = '';
  let turnDone = false;

  // Buffered event queue so we can `yield` across the async notification
  // callback. Each notification pushes zero or more ProviderEvents; the
  // generator drains the buffer.
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: thread.id });
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        if (delta) resultText += delta;
        break;
      }
      case 'item/completed': {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agentMessage' && item.text) resultText = item.text;
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as { total?: { inputTokens?: number } } | undefined;
        if (usage?.total?.inputTokens !== undefined) setInputTokens(usage.total.inputTokens);
        break;
      }
      case 'turn/completed':
        turnDone = true;
        break;
      case 'turn/failed': {
        const e = params.error as { message?: string } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        turnDone = true;
        break;
      }
      case 'thread/status/changed': {
        const status = params.status as string | undefined;
        if (status) buffer.push({ type: 'progress', message: `status: ${status}` });
        break;
      }
      default:
        // Silently handle the many item/* notifications — they already
        // contributed an activity event above.
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  const timer = setTimeout(() => {
    turnState.error = new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`);
    turnDone = true;
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    await startCodexTurn(server, { threadId, inputText, model, cwd });

    while (true) {
      while (buffer.length > 0) {
        const ev = buffer.shift()!;
        yield ev;
      }
      if (turnDone) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    while (buffer.length > 0) yield buffer.shift()!;

    if (turnState.error) {
      yield { type: 'error', message: turnState.error.message, retryable: false };
      return;
    }

    yield { type: 'result', text: resultText || null };
  } finally {
    clearTimeout(timer);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
