import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/**
 * Claude Code applies a settings file's `env` block to its own process
 * environment. A few keys there silently change turn semantics in ways the
 * agent-runner cannot see or recover from — `CLAUDE_CODE_MAX_TURNS` capped
 * every autonomous task at 15 tool calls on a live install ("Reached maximum
 * number of turns (15)"). These files are agent-writable (the shared
 * `.claude-shared/settings.json` and the group's project-level
 * `.claude/settings*.json`), so the guard runs host-side on every spawn and
 * strips the keys, logging where the stray value came from.
 *
 * The container-side provider also passes an explicit SDK `maxTurns` (which
 * wins over the env var) — this guard is defense in depth plus diagnostics.
 */
export const FORBIDDEN_CLAUDE_SETTINGS_ENV_KEYS = ['CLAUDE_CODE_MAX_TURNS'];

/**
 * Strip forbidden `env` keys from one Claude settings file. Returns the keys
 * removed (empty when nothing changed or the file is absent/unparseable —
 * never throws: a broken settings file is Claude Code's problem to report).
 */
export function stripForbiddenClaudeSettingsEnv(settingsFile: string): string[] {
  let parsed: unknown;
  /* eslint-disable no-catch-all/no-catch-all -- a settings file this guard cannot read or rewrite must never block a spawn; Claude Code reports a broken file itself */
  try {
    if (!fs.existsSync(settingsFile)) return [];
    parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch (err) {
    log.warn('Claude settings guard: could not read settings file; leaving it unchanged', {
      settingsFile,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.env)) return [];

  const removed: string[] = [];
  for (const key of FORBIDDEN_CLAUDE_SETTINGS_ENV_KEYS) {
    if (key in parsed.env) {
      removed.push(`${key}=${String(parsed.env[key])}`);
      delete parsed.env[key];
    }
  }
  if (removed.length === 0) return [];

  try {
    const tmp = `${settingsFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n');
    fs.renameSync(tmp, settingsFile);
    log.warn('Claude settings guard: removed turn-limiting env key(s) from settings file', {
      settingsFile,
      removed,
    });
  } catch (err) {
    log.warn('Claude settings guard: could not rewrite settings file', {
      settingsFile,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return removed;
}

/**
 * All Claude settings files a group's container will load: the shared
 * user-level file mounted at ~/.claude and the project-level files inside
 * the group folder (mounted at /workspace/agent).
 */
export function claudeSettingsFilesForGroup(claudeSharedDir: string, groupDir: string): string[] {
  return [
    path.join(claudeSharedDir, 'settings.json'),
    path.join(groupDir, '.claude', 'settings.json'),
    path.join(groupDir, '.claude', 'settings.local.json'),
  ];
}

/** Run the guard over every settings file of a group. Returns removed keys per file. */
export function guardGroupClaudeSettings(claudeSharedDir: string, groupDir: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const file of claudeSettingsFilesForGroup(claudeSharedDir, groupDir)) {
    const removed = stripForbiddenClaudeSettingsEnv(file);
    if (removed.length > 0) result[file] = removed;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
