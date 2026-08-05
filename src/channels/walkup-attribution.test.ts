/**
 * Walk-up source-attribution parsing — the campaign tag ("(avigail-linkedin-1)")
 * embedded in the landing's pre-filled first WhatsApp message. The strict
 * end-anchored form is canonical; the tolerant fallback covers users who edit
 * the pre-fill (trailing period, emoji, extra sentence) — those used to land
 * as "לא ידוע" on the panel.
 */
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
