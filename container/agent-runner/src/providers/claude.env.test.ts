import { describe, expect, it } from 'bun:test';

import { resolveMaxTurns, sanitizeSdkEnv } from './claude.js';

describe('claude provider SDK env', () => {
  it('drops an inherited CLAUDE_CODE_MAX_TURNS and keeps everything else', () => {
    const out = sanitizeSdkEnv({ CLAUDE_CODE_MAX_TURNS: '15', TZ: 'Asia/Jerusalem', HOME: '/home/node' });
    expect(out.CLAUDE_CODE_MAX_TURNS).toBeUndefined();
    expect(out.TZ).toBe('Asia/Jerusalem');
    expect(out.HOME).toBe('/home/node');
  });

  it('is a no-op when nothing forbidden is present', () => {
    const input = { TZ: 'UTC' };
    expect(sanitizeSdkEnv(input)).toEqual(input);
  });

  it('resolves the per-prompt turn cap: operator override or a generous default', () => {
    expect(resolveMaxTurns(undefined)).toBe(1000);
    expect(resolveMaxTurns('')).toBe(1000);
    expect(resolveMaxTurns('abc')).toBe(1000);
    expect(resolveMaxTurns('0')).toBe(1000);
    expect(resolveMaxTurns('-5')).toBe(1000);
    expect(resolveMaxTurns('250')).toBe(250);
  });
});
