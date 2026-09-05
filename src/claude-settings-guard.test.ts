import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claudeSettingsFilesForGroup,
  guardGroupClaudeSettings,
  stripForbiddenClaudeSettingsEnv,
} from './claude-settings-guard.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-guard-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, value: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

describe('stripForbiddenClaudeSettingsEnv', () => {
  it('removes CLAUDE_CODE_MAX_TURNS and keeps every other key intact', () => {
    const file = write(path.join(dir, 'settings.json'), {
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_MAX_TURNS: '15', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'bun /app/src/compact-instructions.ts' }] }] },
    });

    expect(stripForbiddenClaudeSettingsEnv(file)).toEqual(['CLAUDE_CODE_MAX_TURNS=15']);

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(after.autoMemoryEnabled).toBe(false);
    expect(after.hooks.PreCompact).toHaveLength(1);
  });

  it('is a no-op (no rewrite) when nothing forbidden is present', () => {
    const file = write(path.join(dir, 'settings.json'), { env: { TZ: 'UTC' } });
    const before = fs.statSync(file).mtimeMs;
    expect(stripForbiddenClaudeSettingsEnv(file)).toEqual([]);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('tolerates a missing or malformed file', () => {
    expect(stripForbiddenClaudeSettingsEnv(path.join(dir, 'nope.json'))).toEqual([]);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(stripForbiddenClaudeSettingsEnv(bad)).toEqual([]);
    expect(fs.readFileSync(bad, 'utf-8')).toBe('{not json');
  });
});

describe('guardGroupClaudeSettings', () => {
  it('covers the shared user-level file and both project-level files', () => {
    const shared = path.join(dir, 'shared');
    const group = path.join(dir, 'group');
    expect(claudeSettingsFilesForGroup(shared, group)).toEqual([
      path.join(shared, 'settings.json'),
      path.join(group, '.claude', 'settings.json'),
      path.join(group, '.claude', 'settings.local.json'),
    ]);

    write(path.join(shared, 'settings.json'), { env: { CLAUDE_CODE_MAX_TURNS: '15' } });
    write(path.join(group, '.claude', 'settings.local.json'), { env: { CLAUDE_CODE_MAX_TURNS: '8', FOO: 'bar' } });

    const removed = guardGroupClaudeSettings(shared, group);
    expect(Object.keys(removed)).toHaveLength(2);
    expect(removed[path.join(shared, 'settings.json')]).toEqual(['CLAUDE_CODE_MAX_TURNS=15']);
    expect(removed[path.join(group, '.claude', 'settings.local.json')]).toEqual(['CLAUDE_CODE_MAX_TURNS=8']);
    expect(JSON.parse(fs.readFileSync(path.join(group, '.claude', 'settings.local.json'), 'utf-8')).env).toEqual({
      FOO: 'bar',
    });
  });
});
