import { afterEach, describe, expect, it } from 'vitest';

import { walkupDefaultSrc, walkupLang } from './activation.js';

describe('walk-up (code-less first contact)', () => {
  afterEach(() => {
    delete process.env.JONI_WALKUP_DEFAULT_SRC;
  });
  it('defaults to Hebrew for short or Latin-only greetings', () => {
    for (const t of ['hi', 'ok', 'Hi!', 'hello there', 'https://www.linkedin.com/jobs/view/123', '👍', '', 'שלום']) {
      expect(walkupLang(t)).toBe('he');
    }
  });
  it('uses English only when the message is clearly English', () => {
    expect(walkupLang('Hi, I am looking for a new job')).toBe('en');
    expect(walkupLang('Hello I need help with my job search')).toBe('en');
  });
  it('any Hebrew wins', () => {
    expect(walkupLang('Hi I am looking for עבודה')).toBe('he');
  });
  it('code-less contact is a job-search pilot by default; env can override or disable', () => {
    expect(walkupDefaultSrc()).toBe('agent4job');
    process.env.JONI_WALKUP_DEFAULT_SRC = 'jobs';
    expect(walkupDefaultSrc()).toBe('jobs');
    process.env.JONI_WALKUP_DEFAULT_SRC = '';
    expect(walkupDefaultSrc()).toBeNull();
  });
});
