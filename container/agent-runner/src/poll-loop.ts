import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut, getOutboundCount } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  getContinuation,
  migrateLegacyContinuation,
  setContinuation,
  loadFallbackState,
  saveFallbackState,
  getRateLimitWarnedAt,
  setRateLimitWarnedAt,
} from './db/session-state.js';
import { recordUsage } from './db/usage.js';
import { QuotaExhaustedError, isQuotaErrorMessage } from './quota.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
  /**
   * Optional overflow provider. When the primary provider fails a turn with
   * a quota-exhaustion error, the unanswered prompt is retried once on this
   * provider and the user is notified of the switch. Every new turn starts
   * on the primary again, so recovery back to the primary is automatic.
   */
  fallback?: {
    provider: AgentProvider;
    providerName: string;
  };
}

// User-facing notices for the fallback flow. Sent to the same destination
// the failed turn was routed to.
const FALLBACK_SWITCH_NOTICE =
  '⚠️ מכסת Claude נגמרה כרגע — ממשיך לענות דרך Codex (OpenAI). אחזור ל-Claude אוטומטית כשהמכסה תתחדש.';
const FALLBACK_RETURN_NOTICE = '✅ מכסת Claude התחדשה — חזרתי לענות דרך Claude.';
const FALLBACK_FAILED_NOTICE = '❌ גם מנוע הגיבוי (Codex) לא הצליח לענות כרגע. נסו שוב מאוחר יותר.';

// Proactive heads-up sent once per rate-limit window when Claude's own usage
// crosses the warning line — BEFORE the quota actually runs out and the
// fallback kicks in. Gives the user a chance to wrap up on Claude.
const RATE_LIMIT_WARN_THRESHOLD = 90;

function nearingLimitNotice(utilization?: number): string {
  const pct = typeof utilization === 'number' ? `~${Math.round(utilization)}%` : 'רוב המכסה';
  return `🔔 ניצול מכסת Claude עומד על ${pct} מהחלון הנוכחי — מתקרבים למכסה. אם היא תיגמר אעבור זמנית ל-Codex ואחזור אוטומטית כשתתחדש.`;
}

/**
 * Should we send the proactive "nearing the limit" heads-up for this rate-limit
 * telemetry? True when usage crosses the warning line (SDK `allowed_warning`
 * status or utilization ≥ threshold) AND we haven't already warned for this
 * window (identified by its `resetsAt`). Pure — the caller persists the window.
 */
export function shouldWarnNearingLimit(
  ev: { status: string; utilization?: number; resetsAt?: number },
  lastWarnedResetsAt: number | undefined,
): boolean {
  const nearing = ev.status === 'allowed_warning' || (ev.utilization ?? 0) >= RATE_LIMIT_WARN_THRESHOLD;
  if (!nearing) return false;
  // New window (different resetsAt) → warn again; same window → stay quiet.
  return (ev.resetsAt ?? 0) !== (lastWarnedResetsAt ?? -1);
}

// How long to keep serving from the fallback after a primary quota-exhaustion
// before re-probing the primary. During this window every message is routed
// straight to the fallback instead of paying a guaranteed-failing primary
// attempt first — faster replies during an outage and no wasted primary calls.
// Trade-off: recovery back to the primary lags the real quota reset by at most
// this window, but the fallback serves meanwhile so it's not user-facing
// downtime.
const PRIMARY_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Per-loop quota-fallback state. Instantiated once per runPollLoop call (NOT
 * module-global) so concurrent or sequential loops — and tests — never bleed
 * outage state into one another.
 */
export interface FallbackState {
  // True from the moment we announce a switch to the fallback until a primary
  // turn succeeds again. Gates the switch notice so the outage is announced
  // ONCE (not once per message) and drives the one-shot FALLBACK_RETURN_NOTICE
  // when the primary recovers.
  onFallback: boolean;
  // Epoch-ms until which the primary is treated as quota-exhausted and skipped
  // in favour of the fallback. 0 = primary is live. Refreshed on every primary
  // quota error, so a still-down primary keeps extending the window.
  primaryCooldownUntil: number;
}

/** Fresh outage state — primary live, nothing announced. */
export function newFallbackState(): FallbackState {
  return { onFallback: false, primaryCooldownUntil: 0 };
}

/**
 * Should this batch skip the primary and go straight to the fallback? True
 * while a fallback is configured and the primary is inside its quota cooldown.
 */
export function isPrimaryInCooldown(fbState: FallbackState, hasFallback: boolean, now: number): boolean {
  return hasFallback && now < fbState.primaryCooldownUntil;
}

/**
 * Record a primary quota exhaustion: open (or extend) the cooldown and report
 * whether the switch should be announced. `announce` is true only on the first
 * turn of an outage — so the user is told once, not once per message.
 */
export function registerPrimaryQuota(fbState: FallbackState, now: number): { announce: boolean } {
  fbState.primaryCooldownUntil = now + PRIMARY_COOLDOWN_MS;
  if (fbState.onFallback) return { announce: false };
  fbState.onFallback = true;
  return { announce: true };
}

/**
 * Record a successful primary turn: clear the outage state and report whether
 * the recovery notice should be sent (true only if we had switched away).
 */
export function registerPrimaryRecovery(fbState: FallbackState): { notifyReturn: boolean } {
  if (!fbState.onFallback) return { notifyReturn: false };
  fbState.onFallback = false;
  fbState.primaryCooldownUntil = 0;
  return { notifyReturn: true };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  // Quota-fallback outage state, scoped to this loop instance. Rehydrate from
  // disk so a mid-outage restart (e.g. the host watchdog) resumes the same
  // state instead of re-announcing the switch. A cooldown that already elapsed
  // during downtime simply reads as expired and the primary is re-probed.
  const fbState = newFallbackState();
  const persistedFb = loadFallbackState();
  if (persistedFb) {
    fbState.onFallback = persistedFb.onFallback;
    fbState.primaryCooldownUntil = persistedFb.primaryCooldownUntil;
    if (fbState.onFallback) log(`Resuming fallback outage state (cooldown until ${new Date(fbState.primaryCooldownUntil).toISOString()})`);
  }

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      if (config.fallback && isPrimaryInCooldown(fbState, true, Date.now())) {
        // Primary is in a quota cooldown — serve this batch straight from the
        // fallback rather than re-probing a primary we already know is out of
        // quota. Skips the guaranteed-failing primary attempt (latency + a
        // wasted SDK subprocess) that this batch would otherwise pay, and
        // avoids re-announcing the switch. Recovery is handled below: once the
        // cooldown lapses the next batch takes the primary path again.
        log(`Primary in quota cooldown — serving via fallback '${config.fallback.providerName}'`);
        await serveViaFallback(config.fallback, prompt, routing, config.cwd, config.systemContext);
      } else {
        // Process the query while concurrently polling for new messages
        const query = config.provider.query({
          prompt,
          continuation,
          cwd: config.cwd,
          systemContext: config.systemContext,
        });
        try {
          const result = await processQuery(
            query,
            routing,
            processingIds,
            config.providerName,
            config.provider.onExchangeComplete?.bind(config.provider),
            prompt,
            continuation,
            fbState,
          );
          if (result.continuation && result.continuation !== continuation) {
            continuation = result.continuation;
            setContinuation(config.providerName, continuation);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Query error: ${errMsg}`);

          // Quota exhaustion on the primary → retry the unanswered prompt on the
          // fallback provider. QuotaExhaustedError carries the exact prompt
          // segment that went unanswered; a plain thrown error that reads like
          // quota (SDK subprocess died on a usage-limit response) retries the
          // batch's initial prompt.
          const quotaPrompt =
            err instanceof QuotaExhaustedError ? err.lastPrompt : isQuotaErrorMessage(errMsg) ? prompt : null;

          if (quotaPrompt !== null && config.fallback) {
            // Open (or extend) the cooldown so subsequent messages skip the
            // primary entirely until it likely recovers, and announce the
            // switch exactly once per outage.
            const { announce } = registerPrimaryQuota(fbState, Date.now());
            saveFallbackState(fbState);
            if (announce) {
              log(`Primary quota exhausted — switching to fallback '${config.fallback.providerName}' for up to ${PRIMARY_COOLDOWN_MS / 60000}m`);
              writeNotice(routing, FALLBACK_SWITCH_NOTICE);
            } else {
              log(`Primary still quota-exhausted — extending fallback cooldown (switch already announced)`);
            }
            await serveViaFallback(config.fallback, quotaPrompt, routing, config.cwd, config.systemContext);
          } else {
            // Stale/corrupt continuation recovery: ask the provider whether
            // this error means the stored continuation is unusable, and clear
            // it so the next attempt starts fresh.
            if (continuation && config.provider.isSessionInvalid(err)) {
              log(`Stale session detected (${continuation}) — clearing for next retry`);
              continuation = undefined;
              clearContinuation(config.providerName);
            }

            // Write error response so the user knows something went wrong
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: JSON.stringify({ text: `Error: ${errMsg}` }),
            });
          }
        }
      }
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  fbState?: FallbackState,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [initialPrompt];

  // One outbound-row-count snapshot per push to the query (FIFO, 1:1 with
  // 'result' events), taken right before each push. Diffing against the
  // count at the matching 'result' tells us whether the agent already
  // delivered something this turn via an MCP tool (send_message, etc.) —
  // those write straight to outbound.db and never appear in the <message
  // to="..."> blocks that dispatchResultText parses, so without this a
  // turn that calls send_message and then signs off with unwrapped text
  // ("Done, I let them know.") looks indistinguishable from one that sent
  // nothing at all.
  const outboundSnapshots: number[] = [getOutboundCount()];

  // Most recent user-content prompt segment sent into the query (initial
  // batch or follow-up push — not system nudges). On quota exhaustion this
  // is the segment that went unanswered, handed to the fallback provider.
  let lastPrompt = initialPrompt;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        outboundSnapshots.push(getOutboundCount());
        lastPrompt = prompt;
        query.push(prompt);
        archivePrompts.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'error' && event.classification === 'quota') {
        // Provider is out of quota — this query cannot answer the current
        // segment. Abort and surface to runPollLoop, which retries the
        // segment on the fallback provider (when one is configured).
        query.abort();
        throw new QuotaExhaustedError(event.message, lastPrompt);
      } else if (event.type === 'rate_limit') {
        // Proactive heads-up: Claude's own usage is climbing. Warn once per
        // window (deduped + persisted by resetsAt) before the quota actually
        // runs out and the fallback takes over.
        if (shouldWarnNearingLimit(event, getRateLimitWarnedAt())) {
          setRateLimitWarnedAt(event.resetsAt ?? 0);
          log(`Claude usage nearing limit (${event.utilization ?? '?'}%, status=${event.status}) — sending heads-up`);
          writeNotice(routing, nearingLimitNotice(event.utilization));
        }
      } else if (event.type === 'result') {
        // Record per-turn token usage for the operator dashboard. Best-effort:
        // a metering write must never break the agent's turn.
        if (event.usage) {
          try {
            recordUsage(event.usage, event.model ?? null, event.costUsd ?? 0);
          } catch (err) {
            log(`usage record failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        // We were serving via the fallback; this successful primary turn means
        // quota recovered — clear the outage state and tell the user once.
        if (fbState && registerPrimaryRecovery(fbState).notifyReturn) {
          saveFallbackState(fbState);
          writeNotice(routing, FALLBACK_RETURN_NOTICE);
        }
        // Pop the snapshot taken before this turn's prompt was pushed. Falls
        // back to the current count (i.e. "nothing sent yet") if the queue
        // is ever empty, which only happens if pushes and results drift out
        // of the 1:1 order the provider contract guarantees.
        const outboundBeforeTurn = outboundSnapshots.shift() ?? getOutboundCount();
        if (event.text) {
          const { sent, hasUnwrapped } = dispatchResultText(event.text, routing);
          if (sent === 0 && event.isError === true) {
            // Non-retryable error turn (e.g. a 403 billing_error) with no
            // <message> envelope: deliver the notice instead of dropping it as
            // scratchpad, and skip the re-wrap nudge — it would just re-hammer
            // the failing gateway turn after turn.
            deliverErrorResult(event.text, routing);
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: 'error',
            });
            archivePrompts.shift();
          } else {
            // dispatchResultText writes zero outbound rows when hasUnwrapped is
            // true (sent === 0), so any growth in the count here came from an
            // MCP tool (send_message, ask_user_question, etc.) called earlier
            // in this same turn — a real delivery that block-parsing can't see.
            const deliveredViaToolThisTurn = hasUnwrapped && getOutboundCount() > outboundBeforeTurn;
            const willRetryWrapping = hasUnwrapped && !deliveredViaToolThisTurn && !unwrappedNudged;
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: hasUnwrapped && !deliveredViaToolThisTurn ? 'undelivered' : 'completed',
            });
            if (willRetryWrapping) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              // Keep the snapshot FIFO 1:1 with pushes into the query.
              outboundSnapshots.push(getOutboundCount());
              query.push(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
              );
            }
            // The wrapping-retry result answers the SAME user prompt — keep it
            // queued so the retry archives against it, not the nudge text.
            if (!willRetryWrapping) archivePrompts.shift();
          }
        } else {
          archivePrompts.shift();
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write a short system notice to the turn's origin destination. */
function writeNotice(routing: RoutingContext, text: string): void {
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Serve one batch on the fallback provider, swallowing a fallback failure into
 * a user-facing "try again later" notice. Used both when the primary just hit
 * quota and when we're inside the primary's quota cooldown. Kept separate from
 * runFallbackTurn (which throws on failure) so the cooldown fast-path and the
 * quota-catch path share identical failure handling.
 */
async function serveViaFallback(
  fallback: { provider: AgentProvider; providerName: string },
  prompt: string,
  routing: RoutingContext,
  cwd: string,
  systemContext?: { instructions?: string },
): Promise<void> {
  try {
    await runFallbackTurn(fallback, prompt, routing, cwd, systemContext);
  } catch (fbErr) {
    const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
    log(`Fallback turn failed: ${fbMsg}`);
    writeNotice(routing, FALLBACK_FAILED_NOTICE);
  }
}

/**
 * Run a single turn on the fallback provider: retry the unanswered prompt,
 * dispatch the result, persist the fallback's own continuation (kept in its
 * own per-provider slot so the fallback conversation also has memory), and
 * close the query so the outer loop returns to the primary provider on the
 * next batch.
 *
 * Exported for tests.
 */
export async function runFallbackTurn(
  fallback: { provider: AgentProvider; providerName: string },
  prompt: string,
  routing: RoutingContext,
  cwd: string,
  systemContext?: { instructions?: string },
): Promise<void> {
  // Self-heal for a stuck/stale fallback thread — the failure mode that froze
  // a sibling pilot: the fallback keeps resuming a Codex thread the server no
  // longer knows about ("thread not found"), so every turn fails the same way.
  // Try resuming the stored thread; if THAT attempt fails specifically because
  // the thread is stale, drop it and retry once on a fresh thread. Other
  // failures propagate unchanged (a transient hiccup shouldn't nuke a good
  // thread's continuity).
  const resumed = getContinuation(fallback.providerName);
  try {
    await runFallbackAttempt(fallback, prompt, routing, cwd, systemContext, resumed);
  } catch (err) {
    if (resumed && fallback.provider.isSessionInvalid(err)) {
      log(`Fallback thread ${resumed} is stale — self-healing: clearing and retrying on a fresh thread`);
      clearContinuation(fallback.providerName);
      await runFallbackAttempt(fallback, prompt, routing, cwd, systemContext, undefined);
      return;
    }
    throw err;
  }
}

/**
 * A single fallback attempt against a specific continuation (or a fresh thread
 * when `continuation` is undefined). Throws on stale-thread error events so the
 * caller's self-heal can catch and retry.
 */
async function runFallbackAttempt(
  fallback: { provider: AgentProvider; providerName: string },
  prompt: string,
  routing: RoutingContext,
  cwd: string,
  systemContext: { instructions?: string } | undefined,
  continuation: string | undefined,
): Promise<void> {
  // Snapshot the outbound row count before the turn: if it grows, the agent
  // delivered via an MCP tool (send_message, ...) and a bare unwrapped final
  // text is scratchpad — re-nudging would produce a duplicate reply.
  const outboundBefore = getOutboundCount();
  const query = fallback.provider.query({ prompt, continuation, cwd, systemContext });

  let nudged = false;
  let gotResult = false;
  try {
    for await (const event of query.events) {
      touchHeartbeat();
      if (event.type === 'init') {
        setContinuation(fallback.providerName, event.continuation);
      } else if (event.type === 'error' && event.classification === 'quota') {
        query.abort();
        throw new Error(`Fallback provider quota exhausted: ${event.message}`);
      } else if (event.type === 'error' && fallback.provider.isSessionInvalid(new Error(event.message))) {
        // Stale/stuck-thread error — abort so runFallbackTurn's self-heal can
        // clear the thread and retry fresh. Non-stale errors are left to the
        // stream as before (they may be transient and recover on their own).
        query.abort();
        throw new Error(event.message);
      } else if (event.type === 'result') {
        gotResult = true;
        if (event.text) {
          const { hasUnwrapped } = dispatchResultText(event.text, routing);
          const alreadySentThisTurn = getOutboundCount() > outboundBefore;
          if (hasUnwrapped && !alreadySentThisTurn && !nudged) {
            // Same one-shot re-wrap nudge as the primary path — give the
            // fallback one chance to deliver, then close regardless.
            nudged = true;
            gotResult = false;
            const names = getAllDestinations()
              .map((d) => d.name)
              .join(', ');
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `Your destinations: ${names}. Please re-send your response with the correct wrapping.</system>`,
            );
            continue;
          }
        }
        // Turn answered — close the stream so control returns to the
        // primary provider for the next batch.
        query.end();
      }
    }
  } finally {
    if (!gotResult) query.abort();
  }
  if (!gotResult) {
    throw new Error('Fallback provider produced no result');
  }
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'rate_limit':
      log(`Rate limit: status=${event.status}, utilization=${event.utilization ?? '?'}%, type=${event.rateLimitType ?? '?'}`);
      break;
  }
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
function deliverErrorResult(text: string, routing: RoutingContext): void {
  log('Error result with no <message> envelope — delivering to channel');
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
function dispatchResultText(text: string, routing: RoutingContext): { sent: number; hasUnwrapped: boolean } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const content = JSON.stringify({ text: body });

  // Duplicate sends (same text already sent via the send_message MCP tool
  // this turn) are suppressed centrally in writeMessageOut — see
  // findRecentDuplicateSeq in db/messages-out.ts.

  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content,
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
