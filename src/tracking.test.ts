/**
 * Landing-funnel tracking store tests.
 *
 * Two layers:
 *   - Pure folding (buildSummary / normalizeIncoming): the spec's collapse rules,
 *     independent of any DB.
 *   - Storage round-trip (ensureSchema + insertRecord + selectRows): a real
 *     better-sqlite3 file so persistence and the read path are exercised together.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { normalizeIncoming, buildSummary, ensureSchema, insertRecord, selectRows, type StoredRow } from './tracking.js';

const NOW = '2026-07-13T12:00:00.000Z';

/** Build a stored-row (events as the JSON string the DB holds). */
function row(r: Omit<Partial<StoredRow>, 'events'> & { events?: string[] }): Partial<StoredRow> {
  return {
    vid: r.vid ?? '',
    src: r.src ?? '',
    max_step: r.max_step ?? 0,
    dwell_ms: r.dwell_ms ?? 0,
    submitted: r.submitted ?? 0,
    events: JSON.stringify(r.events ?? []),
  };
}

describe('buildSummary — funnel fold', () => {
  // Four visitors covering every rule:
  //  A (google): reached form, cta_click event + reached_form event, not submitted → abandoned
  //  B (google): reached form via maxStep=4, register_submit event → converted
  //  C (twitter): clicked via maxStep=1 only, no form → dropped-no-form
  //  D (''/direct): bounce, maxStep 0, dwell 0
  const rows = [
    // A — two rows (visit + session) for the same vid
    row({ vid: 'A', src: 'google' }),
    row({ vid: 'A', src: 'google', max_step: 4, dwell_ms: 5000, events: ['cta_click', 'reached_form'] }),
    // B
    row({
      vid: 'B',
      src: 'google',
      max_step: 4,
      dwell_ms: 3000,
      submitted: 1,
      events: ['reached_form', 'register_submit'],
    }),
    // C
    row({ vid: 'C', src: 'twitter', max_step: 1, dwell_ms: 1000, events: ['cta_click'] }),
    // D
    row({ vid: 'D', src: '', max_step: 0, dwell_ms: 0 }),
  ];

  const s = buildSummary(rows, NOW);

  it('counts the funnel stages per collapsed journey', () => {
    expect(s.funnel).toEqual({
      entered: 4,
      clicked: 3, // A, B, C
      reachedForm: 2, // A, B
      submitted: 1, // B
      droppedNoForm: 2, // 4 - 2
      abandonedForm: 1, // 2 - 1
    });
  });

  it('accumulates cumulative depth (index = screen, value = journeys reaching ≥ it)', () => {
    // A s=4, B s=4, C s=1, D s=0
    expect(s.depth).toEqual([4, 3, 2, 2, 2]);
  });

  it('takes the median dwell over journeys with dwell > 0', () => {
    // dwells > 0: [5000, 3000, 1000] → median 3000 (D's 0 excluded)
    expect(s.medDwellMs).toBe(3000);
  });

  it('groups bySource on raw src, descending by entered', () => {
    expect(s.bySource).toEqual([
      { label: 'google', entered: 2, reachedForm: 2, submitted: 1 },
      { label: 'twitter', entered: 1, reachedForm: 0, submitted: 0 },
      { label: '', entered: 1, reachedForm: 0, submitted: 0 },
    ]);
  });

  it('is ok:true and stamps generated_at', () => {
    expect(s.ok).toBe(true);
    expect(s.generated_at).toBe(NOW);
  });

  it('folds an empty store to a valid zeroed shape', () => {
    const z = buildSummary([], NOW);
    expect(z.funnel).toEqual({
      entered: 0,
      clicked: 0,
      reachedForm: 0,
      submitted: 0,
      droppedNoForm: 0,
      abandonedForm: 0,
    });
    expect(z.depth).toEqual([0, 0, 0, 0, 0]);
    expect(z.medDwellMs).toBe(0);
    expect(z.bySource).toEqual([]);
  });

  it('honors the first non-empty src across a visitor', () => {
    const one = buildSummary(
      [row({ vid: 'X', src: '' }), row({ vid: 'X', src: 'newsletter' }), row({ vid: 'X', src: 'other' })],
      NOW,
    );
    expect(one.bySource).toEqual([{ label: 'newsletter', entered: 1, reachedForm: 0, submitted: 0 }]);
  });

  it('median of an even count averages the two middles', () => {
    const e = buildSummary(
      [
        row({ vid: 'a', dwell_ms: 1000 }),
        row({ vid: 'b', dwell_ms: 2000 }),
        row({ vid: 'c', dwell_ms: 3000 }),
        row({ vid: 'd', dwell_ms: 5000 }),
      ],
      NOW,
    );
    expect(e.medDwellMs).toBe(2500); // (2000 + 3000) / 2
  });
});

describe('buildSummary — traffic totals (visits vs unique visitors, UTC windows)', () => {
  const t = (iso: string) => iso;
  const rows = [
    // A: two visits + a session, one 8 days old
    row({ vid: 'A', src: 'google' }) as Partial<StoredRow>,
    row({ vid: 'A', src: 'google' }) as Partial<StoredRow>,
    row({ vid: 'A', src: 'google', max_step: 4 }) as Partial<StoredRow>,
    // B: one fresh visit; C: one visit 3 days ago; D: legacy row, no type
    row({ vid: 'B' }) as Partial<StoredRow>,
    row({ vid: 'C' }) as Partial<StoredRow>,
    row({ vid: 'D' }) as Partial<StoredRow>,
  ];
  rows[0].type = 'visit';
  rows[0].received_at = t('2026-07-05T12:00:00.000Z'); // 8d old — outside both windows
  rows[1].type = 'visit';
  rows[1].received_at = t('2026-07-13T11:00:00.000Z'); // 1h old
  rows[2].type = 'session';
  rows[2].received_at = t('2026-07-13T11:30:00.000Z');
  rows[3].type = 'visit';
  rows[3].received_at = t('2026-07-13T11:59:00.000Z');
  rows[4].type = 'visit';
  rows[4].received_at = t('2026-07-10T12:00:00.000Z'); // 3d old — in 7d, out of 24h
  rows[5].type = '';
  rows[5].received_at = t('2026-07-13T11:00:00.000Z'); // legacy: counts as visitor, not visit

  const s = buildSummary(rows, '2026-07-13T12:00:00.000Z');

  it('total_visits counts visit rows only; unique_visitors counts distinct vids', () => {
    expect(s.totals.total_visits).toBe(4); // A×2, B, C — session + legacy excluded
    expect(s.totals.unique_visitors).toBe(4); // A, B, C, D
    expect(s.totals.unique_visitors).toBe(s.funnel.entered); // same population
  });

  it('cuts last_24h and last_7d on received_at (server UTC)', () => {
    expect(s.totals.last_24h).toEqual({ visits: 2, unique_visitors: 3 }); // A(1h), B; vids A,B,D
    expect(s.totals.last_7d).toEqual({ visits: 3, unique_visitors: 4 }); // + C(3d)
  });

  it('zeroes cleanly on an empty store', () => {
    const z = buildSummary([], '2026-07-13T12:00:00.000Z');
    expect(z.totals).toEqual({
      total_visits: 0,
      unique_visitors: 0,
      last_24h: { visits: 0, unique_visitors: 0 },
      last_7d: { visits: 0, unique_visitors: 0 },
    });
  });

  it('collapses same-vid visits inside 30 minutes to one (reload / double-fire guard)', () => {
    const mk = (vid: string, iso: string) => {
      const r = row({ vid }) as Partial<StoredRow>;
      r.type = 'visit';
      r.received_at = iso;
      return r;
    };
    const s2 = buildSummary(
      [
        mk('A', '2026-07-13T11:00:00.000Z'),
        mk('A', '2026-07-13T11:00:20.000Z'), // 20s later — deduped
        mk('A', '2026-07-13T11:45:00.000Z'), // 45min after last counted — a new visit
        mk('B', '2026-07-13T11:00:10.000Z'), // other vid — unaffected
      ],
      '2026-07-13T12:00:00.000Z',
    );
    expect(s2.totals.total_visits).toBe(3); // A@11:00, A@11:45, B
    expect(s2.totals.unique_visitors).toBe(2);
    expect(s2.totals.last_24h).toEqual({ visits: 3, unique_visitors: 2 });
  });

  it('rows with unparseable received_at count in all-time but no window', () => {
    const r = row({ vid: 'X' }) as Partial<StoredRow>;
    r.type = 'visit';
    r.received_at = 'not-a-date';
    const one = buildSummary([r], '2026-07-13T12:00:00.000Z');
    expect(one.totals.total_visits).toBe(1);
    expect(one.totals.last_24h.visits).toBe(0);
    expect(one.totals.last_7d.visits).toBe(0);
  });
});

describe('normalizeIncoming — coercion + truncation', () => {
  it('truncates src to 64, ua to 300, events to 90', () => {
    const rec = normalizeIncoming(
      {
        type: 'session',
        vid: 'v1',
        src: 'x'.repeat(100),
        ua: 'u'.repeat(400),
        events: Array.from({ length: 120 }, (_, i) => ({ e: `screen_${i}` })),
      },
      NOW,
    );
    expect(rec.src.length).toBe(64);
    expect(rec.ua.length).toBe(300);
    expect(JSON.parse(rec.events)).toHaveLength(90);
  });

  it('extracts event names from the {e} wire shape', () => {
    const rec = normalizeIncoming({ events: [{ e: 'cta_click' }, { e: 'reached_form' }] }, NOW);
    expect(JSON.parse(rec.events)).toEqual(['cta_click', 'reached_form']);
  });

  it('coerces submitted and numeric fields; sets received_at', () => {
    const rec = normalizeIncoming({ submitted: true, dwell_ms: '4200', max_step: 3 }, NOW);
    expect(rec.submitted).toBe(1);
    expect(rec.dwell_ms).toBe(4200);
    expect(rec.max_step).toBe(3);
    expect(rec.received_at).toBe(NOW);
  });

  it('never throws on garbage input', () => {
    for (const junk of [null, undefined, 42, 'string', []]) {
      const rec = normalizeIncoming(junk, NOW);
      expect(rec.received_at).toBe(NOW);
      expect(rec.vid).toBe('');
      expect(rec.submitted).toBe(0);
      expect(rec.events).toBe('[]');
    }
  });
});

describe('storage round-trip', () => {
  it('persists rows and folds them through the read path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'track-'));
    const dbPath = path.join(dir, 'tracking.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    ensureSchema(db);

    insertRecord(db, normalizeIncoming({ type: 'visit', vid: 'A', src: 'google' }, NOW));
    insertRecord(
      db,
      normalizeIncoming(
        {
          type: 'session',
          vid: 'A',
          src: 'google',
          max_step: 4,
          dwell_ms: 5000,
          submitted: true,
          events: [{ e: 'register_submit' }],
        },
        NOW,
      ),
    );
    db.close();

    // Reopen from disk — proves persistence survives a close (≈ restart).
    const reopened = new Database(dbPath, { readonly: true });
    const rows = selectRows(reopened);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });

    expect(rows).toHaveLength(2);
    const s = buildSummary(rows, NOW);
    expect(s.funnel.entered).toBe(1);
    expect(s.funnel.submitted).toBe(1);
    expect(s.funnel.reachedForm).toBe(1);
    expect(s.bySource).toEqual([{ label: 'google', entered: 1, reachedForm: 1, submitted: 1 }]);
  });
});
