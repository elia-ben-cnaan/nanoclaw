import { describe, expect, it } from 'bun:test';

import {
  MAX_CRASH_RETRIES,
  MAX_HARNESS_RECOVERIES,
  buildCrashResumeNote,
  buildHarnessRecoveryNudge,
  classifyHarnessError,
  isCrashedSubprocessError,
} from './harness-recovery.js';

describe('classifyHarnessError', () => {
  it('recognises the Claude Code turn-cap result', () => {
    expect(classifyHarnessError('Reached maximum number of turns (15)')).toBe('max_turns');
  });

  it('recognises the malformed tool-call result', () => {
    expect(classifyHarnessError("The model's tool call could not be parsed (retry also failed).")).toBe(
      'malformed_tool_call',
    );
  });

  it('leaves billing / quota / unknown errors alone', () => {
    expect(classifyHarnessError('Spending limit reached. Add your own key')).toBeNull();
    expect(classifyHarnessError("You've hit your session limit · resets 7:30am (UTC)")).toBeNull();
    expect(classifyHarnessError('')).toBeNull();
    expect(classifyHarnessError(null)).toBeNull();
    expect(classifyHarnessError(undefined)).toBeNull();
  });
});

describe('isCrashedSubprocessError', () => {
  it('matches the SDK process-transport exit errors', () => {
    expect(isCrashedSubprocessError('Claude Code process terminated by signal SIGKILL')).toBe(true);
    expect(isCrashedSubprocessError('Claude Code process terminated by signal SIGTERM')).toBe(true);
    expect(isCrashedSubprocessError('Claude Code process exited with code 137')).toBe(true);
  });

  it('does not match ordinary query errors', () => {
    expect(isCrashedSubprocessError('No conversation found with session ID abc')).toBe(false);
    expect(isCrashedSubprocessError('Operation aborted')).toBe(false);
    expect(isCrashedSubprocessError(null)).toBe(false);
  });
});

describe('recovery texts', () => {
  it('turn-cap nudge tells the agent to continue, not restart', () => {
    const nudge = buildHarnessRecoveryNudge('max_turns', 1, MAX_HARNESS_RECOVERIES);
    expect(nudge.startsWith('<system>')).toBe(true);
    expect(nudge.endsWith('</system>')).toBe(true);
    expect(nudge).toContain('turn limit');
    expect(nudge).toContain('Continue the same task');
    expect(nudge).toContain(`recovery 1 of ${MAX_HARNESS_RECOVERIES}`);
  });

  it('malformed-call nudge asks for smaller tool inputs', () => {
    const nudge = buildHarnessRecoveryNudge('malformed_tool_call', 2, MAX_HARNESS_RECOVERIES);
    expect(nudge).toContain('smaller pieces');
    expect(nudge).toContain(`recovery 2 of ${MAX_HARNESS_RECOVERIES}`);
  });

  it('crash note carries the error and warns against repeating sent replies', () => {
    const note = buildCrashResumeNote('Claude Code process terminated by signal SIGKILL');
    expect(note).toContain('SIGKILL');
    expect(note).toContain('do not repeat it');
  });

  it('bounds are sane', () => {
    expect(MAX_HARNESS_RECOVERIES).toBeGreaterThan(0);
    expect(MAX_CRASH_RETRIES).toBeGreaterThan(0);
  });
});
