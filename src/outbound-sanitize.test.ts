import { describe, expect, it } from 'vitest';

import { sanitizeOutboundContent, sanitizeOutboundText } from './outbound-sanitize.js';

describe('outbound sanitize', () => {
  it('strips a trailing leaked closing tag', () => {
    expect(sanitizeOutboundText('רוצה שאכין לאביגיל לינק עכשיו?\n</parameter>')).toEqual({
      text: 'רוצה שאכין לאביגיל לינק עכשיו?',
      stripped: true,
    });
  });
  it('drops a whole leaked tool block including its inner values', () => {
    const t = 'שמרתי.\n<function_calls>\n<invoke name="track_job">\n<parameter name="jobId">https://x</parameter>\n</invoke>\n</function_calls>\nמשהו נוסף';
    expect(sanitizeOutboundText(t).text).toBe('שמרתי.\n\nמשהו נוסף');
  });
  it('handles antml-prefixed and attribute-bearing tags', () => {
    expect(sanitizeOutboundText('a <invoke name="x">b</invoke> c').text).toBe('a b c');
  });
  it('leaves normal text and non-tool angle brackets untouched', () => {
    for (const s of ['שלום, איך אפשר לעזור?', 'salary < 20k and > 10k', '<b>bold</b>', 'a <params> b']) {
      expect(sanitizeOutboundText(s)).toEqual({ text: s, stripped: false });
    }
  });
  it('is stateless across calls (no global-regex lastIndex bug)', () => {
    for (let i = 0; i < 3; i++) expect(sanitizeOutboundText('x</parameter>').stripped).toBe(true);
  });
  it('sanitizes text and caption only, in place', () => {
    const c: Record<string, unknown> = { text: 'hi</invoke>', caption: 'cap<parameter name="a">', url: '<invoke>' };
    expect(sanitizeOutboundContent(c).stripped).toBe(true);
    expect(c).toEqual({ text: 'hi', caption: 'cap', url: '<invoke>' });
    expect(sanitizeOutboundContent(null).stripped).toBe(false);
    expect(sanitizeOutboundContent({ text: 42 }).stripped).toBe(false);
  });
});
