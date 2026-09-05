/**
 * Users Board scoring — pure-function tests.
 *
 * Covers the decision boundaries that route a user into the wrong bucket if
 * broken: churn thresholds, referral gating, retention math, awaiting-reply
 * precedence, and the never-talked paths.
 */
import { describe, it, expect } from 'vitest';

import {
  summarizeActivity,
  churnRisk,
  referralReady,
  suggestAction,
  retentionAtDay,
  buildStory,
  distillLastText,
  parseTsMs,
  type UserActivity,
} from './users-board-data.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-06T12:00:00Z');

function activity(overrides: Partial<UserActivity>): UserActivity {
  return {
    count: 0,
    firstMs: null,
    lastMs: null,
    activeDays: [],
    last7: 0,
    prev7: 0,
    lastText: null,
    awaitingReply: false,
    ...overrides,
  };
}

/** Daily-user activity: one message a day for `days` days, ending `endDaysAgo` ago. */
function dailyUser(days: number, endDaysAgo: number): UserActivity {
  const rows = [];
  for (let i = 0; i < days; i++) {
    rows.push({ ms: NOW - (endDaysAgo + days - 1 - i) * DAY, text: 'msg' });
  }
  return summarizeActivity(rows, null, NOW);
}

describe('parseTsMs', () => {
  it('treats zone-less timestamps as UTC (messages_out format)', () => {
    expect(parseTsMs('2026-08-06 10:00:00')).toBe(Date.parse('2026-08-06T10:00:00Z'));
    expect(parseTsMs('2026-08-06T10:00:00.000Z')).toBe(Date.parse('2026-08-06T10:00:00Z'));
  });
});

describe('summarizeActivity', () => {
  it('counts, windows, and flags awaiting-reply when agent reply is older', () => {
    const a = summarizeActivity(
      [
        { ms: NOW - 10 * DAY, text: 'old' },
        { ms: NOW - 1 * DAY, text: 'new' },
      ],
      NOW - 2 * DAY, // agent last replied before the user's last message
      NOW,
    );
    expect(a.count).toBe(2);
    expect(a.last7).toBe(1);
    expect(a.prev7).toBe(1);
    expect(a.lastText).toBe('new');
    expect(a.awaitingReply).toBe(true);
  });

  it('does not flag awaiting-reply when the agent answered after', () => {
    const a = summarizeActivity([{ ms: NOW - DAY, text: 'q' }], NOW - DAY + 60_000, NOW);
    expect(a.awaitingReply).toBe(false);
  });
});

describe('churnRisk', () => {
  it('never talked: 45 while fresh, 90 after 2 days', () => {
    expect(churnRisk(NOW - 1 * DAY, activity({}), NOW)).toBe(45);
    expect(churnRisk(NOW - 3 * DAY, activity({}), NOW)).toBe(90);
  });

  it('active today → low risk', () => {
    expect(churnRisk(NOW - 10 * DAY, dailyUser(10, 0), NOW)).toBeLessThanOrEqual(5);
  });

  it('daily user silent for 5 days → high risk', () => {
    const risk = churnRisk(NOW - 15 * DAY, dailyUser(10, 5), NOW);
    expect(risk).toBeGreaterThanOrEqual(60);
  });

  it('sparse (weekly) user with the same 5-day gap → much lower risk', () => {
    // 3 active days spread over ~3 weeks, last one 5 days ago
    const rows = [
      { ms: NOW - 19 * DAY, text: 'a' },
      { ms: NOW - 12 * DAY, text: 'b' },
      { ms: NOW - 5 * DAY, text: 'c' },
    ];
    const a = summarizeActivity(rows, null, NOW);
    const risk = churnRisk(NOW - 20 * DAY, a, NOW);
    expect(risk).toBeLessThan(50);
  });
});

describe('referralReady', () => {
  it('engaged + tenured + healthy → ready', () => {
    const a = dailyUser(8, 0);
    expect(a.count).toBeGreaterThanOrEqual(8);
    const engaged = { ...a, count: 20 };
    expect(referralReady(engaged, 5, NOW)).toBe(true);
  });

  it('high churn risk blocks referral even when engaged', () => {
    const a = { ...dailyUser(8, 0), count: 20 };
    expect(referralReady(a, 40, NOW)).toBe(false);
  });

  it('too new blocks referral', () => {
    const a = { ...dailyUser(3, 0), count: 20 };
    expect(referralReady(a, 5, NOW)).toBe(false);
  });
});

describe('suggestAction', () => {
  it('awaiting-reply wins over everything (system health first)', () => {
    const a = { ...dailyUser(8, 0), count: 20, awaitingReply: true };
    expect(suggestAction('דנה כהן', a, 5, true, NOW).type).toBe('unstick');
  });

  it('referral moment produces personalized copy text', () => {
    const act = suggestAction('יובל לוי', { ...dailyUser(8, 0), count: 20 }, 5, true, NOW);
    expect(act.type).toBe('referral');
    expect(act.text).toContain('יובל');
  });

  it('never talked → activate', () => {
    expect(suggestAction(null, activity({}), 90, false, NOW).type).toBe('activate');
  });

  it('high risk → reengage with first name only', () => {
    const a = dailyUser(6, 6);
    const act = suggestAction('דנה כהן', a, 75, false, NOW);
    expect(act.type).toBe('reengage');
    expect(act.text).toContain('היי דנה');
    expect(act.text).not.toContain('כהן');
  });

  it('healthy → none', () => {
    expect(suggestAction('א', dailyUser(3, 0), 5, false, NOW).type).toBe('none');
  });
});

describe('retentionAtDay', () => {
  it('cumulative Dn: counts users still messaging at/after day n', () => {
    const users = [
      { signupMs: NOW - 10 * DAY, lastMs: NOW - 1 * DAY }, // retained at D7 (9 days after signup)
      { signupMs: NOW - 10 * DAY, lastMs: NOW - 9.5 * DAY }, // last msg on day 0 — not retained
      { signupMs: NOW - 2 * DAY, lastMs: NOW }, // not eligible for D7
    ];
    const d7 = retentionAtDay(users, 7, NOW);
    expect(d7.eligible).toBe(2);
    expect(d7.retained).toBe(1);
    expect(d7.pct).toBe(50);
  });

  it('empty cohort → null pct, not NaN', () => {
    expect(retentionAtDay([], 1, NOW).pct).toBeNull();
  });

  it('D1 counts a next-day return', () => {
    const users = [{ signupMs: NOW - 3 * DAY, lastMs: NOW - 1.5 * DAY }];
    expect(retentionAtDay(users, 1, NOW).pct).toBe(100);
  });
});

describe('distillLastText', () => {
  it('takes the first clause up to punctuation', () => {
    expect(distillLastText('תתרגם לאנגלית: אני רק חייב להוסיף המשך לדבריו של עופר, שעדיין יש חשיבות')).toBe(
      'תתרגם לאנגלית',
    );
  });

  it('caps long clauses at a word boundary with ellipsis', () => {
    const long = 'אני רוצה שתעזור לי לתכנן את הטיול המשפחתי הגדול שלנו לפורטוגל בקיץ הקרוב כולל מלונות וטיסות';
    const out = distillLastText(long)!;
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it('collapses whitespace and handles null/empty', () => {
    expect(distillLastText('  שלום \n עולם  ')).toBe('שלום עולם');
    expect(distillLastText(null)).toBeNull();
    expect(distillLastText('   ')).toBeNull();
  });

  it('keeps going past an early colon (e.g. "היי:")', () => {
    const out = distillLastText('היי: מה שלומך היום חבר יקר שלי')!;
    expect(out.length).toBeGreaterThanOrEqual(10);
  });
});

describe('buildStory', () => {
  it('never talked, fresh vs stale', () => {
    expect(buildStory('רון א', activity({}), NOW, NOW - 12 * 60 * 60 * 1000)).toContain('נרשם היום');
    expect(buildStory('רון א', activity({}), NOW, NOW - 5 * DAY)).toContain('לפני 5 ימים');
  });

  it('awaiting reply is called out', () => {
    const a = { ...dailyUser(3, 0), awaitingReply: true };
    expect(buildStory('דנה', a, NOW, NOW - 5 * DAY)).toContain('לא קיבל מענה');
  });

  it('quiet gap is stated in days', () => {
    expect(buildStory('דנה', dailyUser(5, 4), NOW, NOW - 10 * DAY)).toContain('שקט 4 ימים');
  });
});
