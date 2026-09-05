/**
 * Harness-level failure recovery.
 *
 * Three failures used to end a turn with a bare error pushed to the user's
 * chat, leaving the task half-done and the user's message lost:
 *
 *   1. `Reached maximum number of turns (N)` — Claude Code's per-prompt turn
 *      cap (SDK `maxTurns`, or the `CLAUDE_CODE_MAX_TURNS` env var it falls
 *      back to). Every tool call is one turn, so a long autonomous task
 *      trips a small cap in minutes. The query stream is still open, so the
 *      right move is to push a "continue" and let the agent finish.
 *   2. `The model's tool call could not be parsed (retry also failed).` —
 *      the model emitted a malformed tool_use block twice (typically a huge
 *      Bash heredoc / Write payload cut off mid-stream). Again the session is
 *      intact; a nudge to re-issue the call in smaller pieces recovers it.
 *   3. `Claude Code process terminated by signal SIGKILL` / `exited with
 *      code N` — the SDK subprocess died (OOM-kill is the usual SIGKILL
 *      source). The transcript is persisted, so one resumed retry of the same
 *      batch usually completes the work instead of dropping it.
 *
 * All helpers here are pure so they can be unit-tested without a DB or SDK.
 */

export type HarnessErrorKind = 'max_turns' | 'malformed_tool_call';

/** Bounded so a genuinely stuck agent can't loop forever on nudges. */
export const MAX_HARNESS_RECOVERIES = 3;

/** One resumed retry per batch after a subprocess crash. */
export const MAX_CRASH_RETRIES = 1;

const MAX_TURNS_RE = /reached maximum number of turns/i;
const MALFORMED_TOOL_CALL_RE = /tool call could not be parsed/i;
const CRASHED_SUBPROCESS_RE = /terminated by signal|exited with code \d+/i;

/**
 * Classify an error-flagged result text as a recoverable harness failure.
 * Returns null for anything else (billing, quota, unknown) so those keep
 * their existing "deliver the notice" path.
 */
export function classifyHarnessError(text: string | null | undefined): HarnessErrorKind | null {
  if (!text) return null;
  if (MAX_TURNS_RE.test(text)) return 'max_turns';
  if (MALFORMED_TOOL_CALL_RE.test(text)) return 'malformed_tool_call';
  return null;
}

/** True when the thrown error means the SDK subprocess itself died. */
export function isCrashedSubprocessError(message: string | null | undefined): boolean {
  if (!message) return false;
  return CRASHED_SUBPROCESS_RE.test(message);
}

/**
 * System nudge pushed into the still-open query so the agent resumes the
 * same user prompt. Phrased for the model, not the user: no apology, no
 * recap, just continue.
 */
export function buildHarnessRecoveryNudge(kind: HarnessErrorKind, attempt: number, max: number): string {
  const tail =
    `This is automatic recovery ${attempt} of ${max} for the current request. ` +
    `Do not apologize or explain the interruption. If the request is fully done, send the final reply now ` +
    `(wrapped in <message to="name">…</message>).`;
  if (kind === 'max_turns') {
    return (
      `<system>The previous attempt stopped because it hit the harness turn limit, not because the task was finished. ` +
      `Continue the same task from exactly where it stopped. Work in fewer, larger steps: batch shell commands, ` +
      `avoid re-reading files you already read, and send a short progress note to the user only if the work will take a while. ` +
      tail +
      `</system>`
    );
  }
  return (
    `<system>Your last tool call was malformed and could not be parsed (this happens with very large tool inputs). ` +
    `Re-issue it in smaller pieces: write big files in several Write/Edit calls of a few hundred lines each, ` +
    `and keep Bash heredocs short. Then continue the same task from where it stopped. ` +
    tail +
    `</system>`
  );
}

/**
 * Note appended to the original prompt when a batch is re-run after the SDK
 * subprocess crashed. The session is resumed, so the agent may already have
 * done part of the work — tell it so it neither repeats sent messages nor
 * starts over.
 */
export function buildCrashResumeNote(errorMessage: string): string {
  return (
    `<system>The previous attempt to handle the message(s) above was interrupted by a runtime crash ` +
    `(${errorMessage}). Your session was resumed. If you already replied or completed part of the work, ` +
    `do not repeat it — continue from where it stopped and finish. Keep memory use low: prefer small tool outputs ` +
    `and avoid loading very large files into context.</system>`
  );
}
