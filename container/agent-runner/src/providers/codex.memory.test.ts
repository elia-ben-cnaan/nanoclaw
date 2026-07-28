import { describe, expect, it } from 'bun:test';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { CodexProvider, composeBaseInstructions } from './codex.js';

describe('codex memory wiring', () => {
  it('query throws when the memory session hook was not registered', () => {
    const provider = new CodexProvider({});
    expect(() => provider.query({ prompt: 'hi', cwd: '/tmp' })).toThrow(/memory session hook was not registered/);
  });

  it('query does not throw once the hook is registered', () => {
    const provider = new CodexProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: '/tmp', continuation: 'thread-1' });
    q.abort();
  });

  it('composeBaseInstructions appends the memory context after the addendum', () => {
    const composed = composeBaseInstructions('ADDENDUM', 'MEMORY-SECTION');
    expect(composed).toContain('ADDENDUM');
    expect(composed).toContain('MEMORY-SECTION');
    expect(composed!.indexOf('ADDENDUM')).toBeLessThan(composed!.indexOf('MEMORY-SECTION'));
  });

  it('composeBaseInstructions omits the memory joint when no context is given (resume)', () => {
    const composed = composeBaseInstructions('ADDENDUM', undefined);
    expect(composed).toContain('ADDENDUM');
    expect(composed).not.toContain('MEMORY-SECTION');
  });
});
