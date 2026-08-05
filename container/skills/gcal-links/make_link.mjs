#!/usr/bin/env bun
/**
 * Deterministic Gmail-compose / Google-Calendar-render link builder.
 * Replaces hand-built links in chat agents: encoding, UTC conversion (with
 * real DST via Asia/Jerusalem), end-time arithmetic, weekday naming — all
 * computed here so the model never does date math or URL encoding by hand.
 *
 * Usage:
 *   bun make_link.mjs email --to a@b.c --subject "..." --body "..."
 *   bun make_link.mjs event --title "..." --date 18.8 --time 07:30 \
 *        [--duration 90] [--add guest@x.y] [--location "..."] [--details "..."]
 *
 * event defaults: duration 15 min; year = current year (Asia/Jerusalem);
 * date also accepts DD.MM.YYYY. Output is key: value lines the agent copies
 * verbatim into the confirmation, then the LINK line.
 */

const TZ = 'Asia/Jerusalem';
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function fail(msg) {
  console.log(`ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : '';
      args[key] = val;
    }
  }
  return args;
}

/** UTC offset (minutes) of TZ at a given UTC instant. */
function tzOffsetMin(utcDate) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utcDate);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - utcDate.getTime()) / 60000);
}

/** Convert local wall time in TZ to a UTC Date (DST-correct, two-pass). */
function localToUtc(y, mo, d, h, mi) {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  guess = new Date(guess.getTime() - tzOffsetMin(guess) * 60000);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - tzOffsetMin(guess) * 60000);
}

function gcalStamp(utcDate) {
  return utcDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

const [mode, ...rest] = process.argv.slice(2);
const a = parseArgs(rest);

if (mode === 'email') {
  const { to, subject, body } = a;
  if (!to || !to.includes('@')) fail('missing/invalid --to');
  if (!subject) fail('missing --subject');
  const p = new URLSearchParams();
  const url =
    `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}` +
    `&su=${encodeURIComponent(subject)}` +
    (body ? `&body=${encodeURIComponent(body)}` : '');
  console.log(`נושא: ${subject}`);
  console.log(`LINK: ${url}`);
} else if (mode === 'event') {
  const { title, date, time } = a;
  if (!title) fail('missing --title');
  if (!date) fail('missing --date (DD.MM or DD.MM.YYYY)');
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) fail('missing/invalid --time (HH:MM, 24h)');
  const dm = date.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (!dm) fail('invalid --date format');
  const now = new Date();
  const curYear = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric' }).format(now));
  let year = dm[3] ? Number(dm[3]) : curYear;
  if (year < 100) year += 2000;
  const day = Number(dm[1]), month = Number(dm[2]);
  const [h, mi] = time.split(':').map(Number);
  if (h > 23 || mi > 59) fail('invalid --time');
  const duration = a.duration ? Number(a.duration) : 15;
  if (!Number.isFinite(duration) || duration <= 0) fail('invalid --duration (minutes)');
  const start = localToUtc(year, month, day, h, mi);
  const end = new Date(start.getTime() + duration * 60000);
  // Hebrew weekday of the LOCAL date (computed at local noon to dodge tz edges)
  const wd = HE_DAYS[Math.round(localToUtc(year, month, day, 12, 0).getTime() / 86400000 + 4) % 7];
  let url =
    `https://calendar.google.com/calendar/render?action=TEMPLATE` +
    `&text=${encodeURIComponent(title)}` +
    `&dates=${gcalStamp(start)}/${gcalStamp(end)}`;
  if (a.add) {
    if (!a.add.includes('@')) fail('invalid --add (guest email)');
    url += `&add=${encodeURIComponent(a.add)}`;
  }
  if (a.location) url += `&location=${encodeURIComponent(a.location)}`;
  if (a.details) url += `&details=${encodeURIComponent(a.details)}`;
  url += `&sf=true&output=xml`;
  console.log(`נושא: ${title}`);
  console.log(`תאריך ושעה: יום ${wd} ${day}.${month}.${year}, ${time}`);
  if (a.duration) console.log(`משך: ${duration} דקות`);
  console.log(`LINK: ${url}`);
} else {
  fail('mode must be "email" or "event"');
}
