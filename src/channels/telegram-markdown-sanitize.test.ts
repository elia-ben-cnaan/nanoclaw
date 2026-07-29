import { describe, it, expect } from 'vitest';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

describe('sanitizeTelegramLegacyMarkdown', () => {
  it('downgrades CommonMark **bold** to legacy *bold*', () => {
    expect(sanitizeTelegramLegacyMarkdown('**Host path**')).toBe('*Host path*');
  });

  it('downgrades CommonMark __bold__ to legacy _italic_', () => {
    expect(sanitizeTelegramLegacyMarkdown('__label__')).toBe('_label_');
  });

  it('leaves balanced legacy *bold* and _italic_ alone', () => {
    expect(sanitizeTelegramLegacyMarkdown('a *b* c _d_ e')).toBe('a *b* c _d_ e');
  });

  it('preserves inline code spans untouched', () => {
    const input = 'see `file_name.py` and `**not bold**` here';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('preserves fenced code blocks untouched', () => {
    const input = '```\nfoo_bar **baz**\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('strips formatting chars on odd delimiter count (unbalanced *)', () => {
    expect(sanitizeTelegramLegacyMarkdown('a * b *c*')).toBe('a  b c');
  });

  it('strips formatting chars on odd delimiter count (unbalanced _)', () => {
    expect(sanitizeTelegramLegacyMarkdown('file_name has _one italic_')).toBe('filename has one italic');
  });

  it('strips brackets when unbalanced', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs here')).toBe('see docs here');
  });

  it('leaves matched brackets (e.g. links) alone when counts balance', () => {
    const input = 'see [docs](https://example.com) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('fixes the real failing message', () => {
    const input =
      'Sure! What do you want to mount, and where should it appear inside the container?\n\n' +
      '- **Host path** (on your machine): e.g. `~/projects/webapp`\n' +
      '- **Container path**: e.g. `workspace/webapp`\n' +
      '- **Read-only or read-write?**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).not.toContain('**');
    expect(out).toContain('*Host path*');
    expect(out).toContain('`~/projects/webapp`');
    expect((out.match(/\*/g) ?? []).length % 2).toBe(0);
  });

  it('is a no-op on empty string', () => {
    expect(sanitizeTelegramLegacyMarkdown('')).toBe('');
  });

  it('replaces dash list bullets with • so the adapter does not re-emit `*` markers', () => {
    expect(sanitizeTelegramLegacyMarkdown('- one\n- two')).toBe('• one\n• two');
  });

  it('preserves indented list structure', () => {
    expect(sanitizeTelegramLegacyMarkdown('  - nested')).toBe('  • nested');
  });

  it('flattens Markdown horizontal rules (---, ***, ___)', () => {
    const input = 'before\n---\n***\n___\nafter';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('before\n⎯⎯⎯\n⎯⎯⎯\n⎯⎯⎯\nafter');
  });

  it('leaves horizontal rules inside code blocks alone', () => {
    const input = '```\n---\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  describe('stripLongDashes option', () => {
    const strip = (s: string) => sanitizeTelegramLegacyMarkdown(s, { stripLongDashes: true });

    it('is off by default: em dash survives', () => {
      expect(sanitizeTelegramLegacyMarkdown('כן — בהחלט')).toBe('כן — בהחלט');
    });

    it('replaces a spaced em dash with a comma', () => {
      expect(strip('כן — בהחלט')).toBe('כן, בהחלט');
    });

    it('replaces an unspaced em dash with a comma', () => {
      expect(strip('word—word')).toBe('word, word');
    });

    it('replaces en dash and horizontal bar too', () => {
      expect(strip('א – ב')).toBe('א, ב');
      expect(strip('א ― ב')).toBe('א, ב');
    });

    it('collapses a comma that already precedes the dash (no double comma)', () => {
      expect(strip('א, — ב')).toBe('א, ב');
    });

    it('never touches dashes inside code', () => {
      const input = 'run `a — b` now';
      expect(strip(input)).toBe(input);
    });

    it('leaves plain hyphens (compound words) alone', () => {
      expect(strip('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    });

    it('collapses a --- markdown HR to a clean paragraph break, not a ⎯ divider', () => {
      expect(strip('לפני\n\n---\n\nאחרי')).toBe('לפני\n\nאחרי');
      expect(strip('לפני\n\n---\n\nאחרי')).not.toContain('⎯');
    });

    it('removes a standalone --- separator line mid-answer (live-observed case)', () => {
      // Exact reported input: a "---" line between two text lines must vanish,
      // leaving a clean paragraph break in its place.
      const out = strip('טקסט\n---\nטקסט');
      expect(out).not.toContain('---');
      expect(out).toBe('טקסט\n\nטקסט');
    });

    it('removes spaced HR variants (- - -, * * *, _ _ _)', () => {
      expect(strip('א\n- - -\nב')).toBe('א\n\nב');
      expect(strip('א\n* * *\nב')).toBe('א\n\nב');
      expect(strip('א\n_ _ _\nב')).toBe('א\n\nב');
    });

    it('drops a long-dash-only separator line between paragraphs', () => {
      expect(strip('פסקה\n\n—\n\nהמשך')).toBe('פסקה\n\nהמשך');
      expect(strip('פסקה\n\n⎯⎯⎯\n\nהמשך')).toBe('פסקה\n\nהמשך');
    });

    it('strips the U+23AF divider char if the model emits it directly', () => {
      expect(strip('א ⎯ ב')).toBe('א, ב');
    });

    it('leaves the ⎯ divider intact when stripLongDashes is OFF (default channels)', () => {
      expect(sanitizeTelegramLegacyMarkdown('before\n---\nafter')).toBe('before\n⎯⎯⎯\nafter');
    });
  });
});
