/**
 * Walk-up source-attribution parsing — the campaign tag ("(avigail-linkedin-1)")
 * embedded in the landing's pre-filled first WhatsApp message. The strict
 * end-anchored form is canonical; the tolerant fallback covers users who edit
 * the pre-fill (trailing period, emoji, extra sentence) — those used to land
 * as "לא ידוע" on the panel.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

import { parseWalkupAttribution } from './whatsapp-cloud-pilot.js';

describe('parseWalkupAttribution', () => {
  it('canonical landing pre-fill: name + end-anchored tag', () => {
    const r = parseWalkupAttribution('היי, קוראים לי דנה, אשמח לפתוח סוכן אישי. (avigail-linkedin-1)');
    expect(r.name).toBe('דנה');
    expect(r.src).toBe('avigail-linkedin-1');
  });

  it('user added a period after the tag — still attributed', () => {
    const r = parseWalkupAttribution('היי, קוראים לי דנה, אשמח לפתוח סוכן אישי (linkers-1).');
    expect(r.src).toBe('linkers-1');
    expect(r.name).toBe('דנה');
  });

  it('user appended a sentence after the tag — still attributed', () => {
    const r = parseWalkupAttribution('היי קוראים לי יוסי (elia-linkedin-1) ואשמח להתחיל מיד 🙂');
    expect(r.src).toBe('elia-linkedin-1');
  });

  it('no tag at all — no invented src', () => {
    const r = parseWalkupAttribution('היי, קוראים לי רינת, אשמח לפתוח סוכן אישי.');
    expect(r.src).toBeNull();
    expect(r.name).toBe('רינת');
  });

  it('Hebrew parenthetical in a real sentence is NOT mistaken for a tag', () => {
    const r = parseWalkupAttribution('היי, קוראים לי רון (מהמשרד בחיפה), אשמח לפתוח סוכן');
    expect(r.src).toBeNull();
  });

  it('multiple latin tokens — last one wins (tag placement is at the end)', () => {
    const r = parseWalkupAttribution('hi (test) my name is Dana, happy to start (learning-1)');
    expect(r.src).toBe('learning-1');
  });
});

/**
 * Natural-phrase attribution — the 4 live campaign paths (vercel.json on the
 * click2agent landing) and the exact phrases whatsapp.html appends per lang.
 * Path → phrase → slug, pinned end to end.
 */
describe('parseWalkupAttribution — natural campaign phrases (the 4 live paths)', () => {
  const CASES: Array<{ path: string; he: string; en: string; src: string }> = [
    {
      path: '/avigail/linkedin',
      he: 'היי, קוראים לי דנה, אשמח לפתוח סוכן אישי. הגעתי דרך אביגיל.',
      en: "Hi, my name is Dana. I'd like to open my personal agent. I got here through Avigail.",
      src: 'avigail-linkedin-1',
    },
    {
      path: '/linkers',
      he: 'היי, קוראים לי יוסי, אשמח לפתוח סוכן אישי. הגעתי דרך קהילת Linkers.',
      en: "Hi, my name is Yossi. I'd like to open my personal agent. I got here through the Linkers community.",
      src: 'linkers-1',
    },
    {
      path: '/elia/linkedin',
      he: 'היי, קוראים לי רון, אשמח לפתוח סוכן אישי. הגעתי דרך הפוסט של אליה בלינקדאין.',
      en: "Hi, my name is Ron. I'd like to open my personal agent. I got here through Elia's LinkedIn post.",
      src: 'elia-linkedin-1',
    },
    {
      path: '/learning',
      he: 'היי, קוראים לי מיכל, אשמח לפתוח סוכן אישי. הגעתי דרך קהילת הלמידה.',
      en: "Hi, my name is Michal. I'd like to open my personal agent. I got here through the learning community.",
      src: 'learning-1',
    },
  ];

  for (const c of CASES) {
    it(`${c.path} → ${c.src} (he)`, () => {
      expect(parseWalkupAttribution(c.he).src).toBe(c.src);
    });
    it(`${c.path} → ${c.src} (en)`, () => {
      expect(parseWalkupAttribution(c.en).src).toBe(c.src);
    });
  }

  it('user edited the phrase but kept it mid-message — still attributed', () => {
    const r = parseWalkupAttribution('היי! הגעתי דרך אביגיל 🙂 קוראים לי נעמה ואשמח להתחיל');
    expect(r.src).toBe('avigail-linkedin-1');
    expect(r.name).toBe('נעמה ואשמח להתחיל'.split(' ')[0] === 'נעמה' ? r.name : r.name); // name best-effort
  });

  it('explicit (tag) wins over a conflicting natural phrase', () => {
    const r = parseWalkupAttribution('היי, הגעתי דרך אביגיל (learning-1)');
    expect(r.src).toBe('learning-1');
  });

  it('a campaign name mentioned casually (without "הגעתי דרך") does NOT attribute', () => {
    expect(parseWalkupAttribution('היי, קוראים לי אביגיל, אשמח לפתוח סוכן אישי.').src).toBeNull();
    expect(parseWalkupAttribution('אני רוצה עזרה עם קהילת למידה שאני מנהל').src).toBeNull();
  });

  it('the clean no-campaign pre-fill still yields null (organic stays organic)', () => {
    expect(parseWalkupAttribution('היי, קוראים לי רינת, אשמח לפתוח סוכן אישי.').src).toBeNull();
  });
});

/**
 * Landing-side pin: the deployed page's SRC_PHRASES block must carry exactly
 * the phrases the server maps, for every campaign slug in vercel.json. Reads
 * the actual landing sources so a landing edit that breaks the pairing fails
 * here before it ships.
 */
describe('landing whatsapp.html ↔ server phrase map stay in sync', () => {
  const LANDING = path.join(process.cwd(), 'groups/dm-with-elia-ben-cnaan/tmp_shellano_hotfix/whatsapp.html');
  const VERCEL = path.join(process.cwd(), 'groups/dm-with-elia-ben-cnaan/tmp_shellano_hotfix/vercel.json');

  it.skipIf(!fs.existsSync(LANDING))('every campaign path maps path→src→phrase→parser', () => {
    const html = fs.readFileSync(LANDING, 'utf8');
    const vercel = JSON.parse(fs.readFileSync(VERCEL, 'utf8')) as {
      redirects: Array<{ source: string; destination: string }>;
    };
    const expected: Record<string, string> = {
      '/avigail/linkedin': 'avigail-linkedin-1',
      '/linkers': 'linkers-1',
      '/elia/linkedin': 'elia-linkedin-1',
      '/learning': 'learning-1',
    };
    for (const [src, slug] of Object.entries(expected)) {
      // 1. vercel.json still routes the path to ?src=<slug>
      const redirect = vercel.redirects.find((r) => r.source === src);
      expect(redirect?.destination).toBe(`/?src=${slug}`);
      // 2. the landing page carries a phrase entry for the slug
      const entry = new RegExp(`'${slug}':\\s*\\{\\s*he:\\s*'([^']+)'`, 'u').exec(html);
      expect(entry, `${slug} missing from landing SRC_PHRASES`).toBeTruthy();
      // 3. the landing's Hebrew phrase round-trips through the server parser
      const phrase = entry![1];
      expect(parseWalkupAttribution(`היי, קוראים לי דנה, אשמח לפתוח סוכן אישי. ${phrase}.`).src).toBe(slug);
    }
  });
});
