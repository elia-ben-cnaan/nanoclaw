import { describe, expect, it } from 'vitest';

import { cliLoopKey, detectCliLoop } from './delivery-action.js';

describe('CLI delivery loop guard', () => {
  it('keys groups-config-get by session and command, ignoring changing request args', () => {
    const a = cliLoopKey('sess-1', 'groups-config-get', { requestId: 'a', includeSecrets: false });
    const b = cliLoopKey('sess-1', 'groups-config-get', { requestId: 'b', includeSecrets: true });

    expect(a).toBe('sess-1:groups-config-get:*');
    expect(b).toBe(a);
  });

  it('normalizes volatile nested args for other commands', () => {
    const a = cliLoopKey('sess-1', 'jobs-list', { filter: { requestId: 'a', status: 'open' } });
    const b = cliLoopKey('sess-1', 'jobs-list', { filter: { status: 'open', requestId: 'b' } });

    expect(b).toBe(a);
  });

  it('counts repeats across volatile arg changes', () => {
    const first = detectCliLoop('sess-count', 'jobs-list', { requestId: 'a', filter: { ts: 1 } }, 1_000);
    const second = detectCliLoop('sess-count', 'jobs-list', { requestId: 'b', filter: { ts: 2 } }, 2_000);

    expect(first).toBe(1);
    expect(second).toBe(2);
  });
});
