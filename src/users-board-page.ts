/**
 * Users Board — HTML page (GET /admin/users).
 *
 * Personal operator board, single reader. The qualitative layer (topic,
 * day-by-day timeline, real quotes, insights) is the point of this board —
 * every card/row carries a one-line topic, and clicking a person opens the
 * full detail: what they've been talking about, day by day, in their own
 * words. Color only where it carries meaning: orange = needs action,
 * teal = referral moment. Everything else is quiet grayscale.
 *
 * Self-contained page; fetches /admin/users-board JSON (list + rollup +
 * aggregate insights) and /admin/user/:slug on demand (detail, cached).
 */

export function renderUsersBoardPage(adminKey: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Users Board</title>
<style>
  :root{
    --bg:#000; --card:#101010; --border:#3A3A3A;
    --fg:#FFF; --dim:#B0B0B0; --faint:#7a7a7a;
    --teal:#56EDD6; --action:#0F756D; --alert:#E85D3A;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);font-family:Inter,system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5}
  a{color:inherit}
  .wrap{max-width:960px;margin:0 auto;padding:16px 14px 60px}

  /* rollup strip */
  .rollup{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--border);
    padding:10px 2px 12px;display:flex;flex-wrap:wrap;gap:8px 22px;align-items:baseline}
  .rollup .num{font-weight:600;color:var(--fg)}
  .rollup .lbl{color:var(--dim);font-size:13px}
  .rollup .metric{white-space:nowrap}
  .chip{cursor:pointer;border:1px solid var(--border);border-radius:999px;padding:2px 12px;font-size:13px;
    background:none;color:var(--fg);font-family:inherit}
  .chip.alert{border-color:var(--alert);color:var(--alert)}
  .chip.teal{border-color:var(--teal);color:var(--teal)}
  .chip.on{background:var(--card)}
  .refresh{margin-inline-start:auto;border:1px solid var(--border);border-radius:999px;padding:2px 12px;
    font-size:13px;background:none;color:var(--dim);font-family:inherit;cursor:pointer}
  .refresh:disabled{opacity:.5;cursor:default}

  /* aggregate insights */
  .agg{margin-top:16px;border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:var(--card)}
  .agg h2{font-size:13px;font-weight:600;color:var(--dim);letter-spacing:.02em;margin-bottom:10px}
  .agg .grp{margin-top:10px}
  .agg .grp:first-child{margin-top:0}
  .agg .grp-lbl{font-size:12px;color:var(--faint);margin-bottom:4px}
  .agg li{color:var(--fg);font-size:13.5px;margin-inline-start:18px}
  .agg .empty{color:var(--faint);font-size:13px}

  /* sections */
  section{margin-top:22px}
  h2{font-size:13px;font-weight:600;color:var(--dim);letter-spacing:.02em;display:flex;align-items:center;gap:8px;cursor:default}
  h2 .cnt{color:var(--faint);font-weight:400}
  h2.alert{color:var(--alert)}
  h2.teal{color:var(--teal)}

  .cards{display:grid;grid-template-columns:1fr;gap:10px;margin-top:10px}
  @media(min-width:760px){.cards{grid-template-columns:1fr 1fr}}

  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;cursor:pointer}
  .card.attention{border-right:3px solid var(--alert)}
  .card.referral{border-right:3px solid var(--teal)}
  .id{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .id .name{font-weight:600;font-size:16px}
  .badge{font-size:12.5px;white-space:nowrap}
  .badge.risk{color:var(--alert)}
  .badge.ref{color:var(--teal)}
  .meta{color:var(--faint);font-size:12.5px;margin-top:2px}
  .topic{margin-top:8px;color:var(--dim);font-size:13.5px}
  .story{margin-top:6px;color:var(--fg)}
  .flag{margin-top:8px;color:var(--alert);font-size:13.5px}

  .act{margin-top:12px;border:1px solid var(--action);border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start}
  .act .txt{flex:1;color:var(--fg);font-size:14px}
  .act .why{display:block;color:var(--faint);font-size:12px;margin-bottom:4px}
  .copy{border:none;border-radius:6px;background:var(--action);color:#fff;font-family:inherit;font-size:13px;
    padding:6px 14px;cursor:pointer;white-space:nowrap}
  .copy:active{opacity:.8}
  .act.info{border-color:var(--border)}
  .act.info .why{color:var(--dim)}

  /* rows */
  .rows{margin-top:10px;border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .row{display:flex;gap:12px;align-items:baseline;padding:9px 14px;border-top:1px solid var(--border);cursor:pointer}
  .row:first-child{border-top:none}
  .row .name{font-weight:500;min-width:110px}
  .row .sub{color:var(--faint);font-size:13px;flex:1}
  .row .topic{margin:0;color:var(--dim);font-size:12.5px;flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .when{color:var(--dim);font-size:13px;white-space:nowrap}
  .row.signup{cursor:default}

  .fb{margin-top:26px;border-top:1px solid var(--border);padding-top:12px}
  .fb h2{color:var(--dim)}
  .fb li{color:var(--dim);font-size:13.5px;margin:6px 18px 0 0}
  .empty{color:var(--faint);font-size:13.5px;margin-top:10px}
  #err{color:var(--alert);margin-top:20px;display:none}
  .stamp{color:var(--faint);font-size:12px;margin-top:30px}
  .toast{position:fixed;bottom:18px;right:18px;background:var(--card);border:1px solid var(--teal);
    color:var(--fg);padding:8px 16px;border-radius:8px;font-size:13.5px;opacity:0;transition:opacity .2s;z-index:50}
  .toast.show{opacity:1}

  /* detail overlay */
  .overlay{position:fixed;inset:0;background:var(--bg);z-index:20;overflow-y:auto;display:none}
  .overlay.open{display:block}
  .dwrap{max-width:720px;margin:0 auto;padding:16px 16px 60px}
  .dclose{border:1px solid var(--border);border-radius:999px;background:none;color:var(--dim);
    font-family:inherit;font-size:13px;padding:5px 14px;cursor:pointer}
  .dhead{margin-top:18px}
  .dhead .name{font-size:22px;font-weight:600}
  .dhead .meta{color:var(--faint);font-size:13px;margin-top:4px}
  .dtopic{margin-top:14px;font-size:16px;color:var(--fg);background:var(--card);border:1px solid var(--border);
    border-radius:10px;padding:12px 14px}
  .dinsights{margin-top:14px;display:grid;grid-template-columns:1fr;gap:8px}
  @media(min-width:600px){.dinsights{grid-template-columns:1fr 1fr}}
  .dins{border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13.5px}
  .dins .lbl{color:var(--faint);font-size:12px;margin-bottom:3px}
  .dins.stuck{border-color:var(--alert)}
  .dins.stuck .lbl{color:var(--alert)}
  .dins.referral{border-color:var(--teal)}
  .dins.referral .lbl{color:var(--teal)}
  .dflags{margin-top:10px;display:flex;flex-wrap:wrap;gap:6px}
  .dflag{border:1px solid var(--alert);color:var(--alert);border-radius:999px;padding:2px 10px;font-size:12px}
  .dsec{margin-top:22px}
  .dsec h3{font-size:13px;font-weight:600;color:var(--dim);letter-spacing:.02em;margin-bottom:10px}
  .quote{border-right:2px solid var(--border);padding:6px 12px;margin-bottom:10px;color:var(--fg);font-size:14px}
  .quote .when{display:block;color:var(--faint);font-size:11.5px;margin-top:3px}
  .day{border-bottom:1px solid var(--border);padding:10px 0}
  .day:last-child{border-bottom:none}
  .day .dhd{display:flex;justify-content:space-between;color:var(--faint);font-size:12px;margin-bottom:4px}
  .day .dsum{color:var(--fg);font-size:14px}
  .stale{color:var(--faint);font-size:11px}
  .dempty{color:var(--faint);font-size:13.5px;margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
  <div class="rollup" id="rollup"></div>
  <div id="agg"></div>
  <div id="err"></div>
  <div id="content"></div>
  <div class="stamp" id="stamp"></div>
</div>
<div class="overlay" id="overlay"><div class="dwrap" id="dcontent"></div></div>
<div class="toast" id="toast">הועתק</div>
<script>
const KEY = ${JSON.stringify(adminKey)};
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let FILTER = null; // null | 'attention' | 'referral'

function toast(msg){ const t=$('#toast'); t.textContent = msg || 'הועתק'; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1400); }

function copyText(text, btn){
  navigator.clipboard.writeText(text).then(()=>{ toast(); btn.textContent='הועתק'; setTimeout(()=>btn.textContent='העתק',1400); });
}

function pct(v){ return v === null ? '—' : v + '%'; }

function renderRollup(r){
  const src = r.signupsBySource.map(s => esc(s.source) + ' ' + s.count).join(' · ');
  $('#rollup').innerHTML =
    '<span class="metric"><span class="num">' + r.totalUsers + '</span> <span class="lbl">משתמשים חיים</span></span>' +
    (src ? '<span class="lbl">(' + src + ')</span>' : '') +
    '<span class="metric"><span class="lbl">D1</span> <span class="num">' + pct(r.retention.d1.pct) + '</span></span>' +
    '<span class="metric"><span class="lbl">D3</span> <span class="num">' + pct(r.retention.d3.pct) + '</span></span>' +
    '<span class="metric"><span class="lbl">D7</span> <span class="num">' + pct(r.retention.d7.pct) + '</span></span>' +
    '<span class="metric"><span class="num">' + r.activeToday + '</span> <span class="lbl">פעילים היום</span></span>' +
    '<span class="metric"><span class="num">' + r.pendingSignups + '</span> <span class="lbl">נרשמו ולא הפעילו</span></span>' +
    '<button class="chip alert' + (FILTER==='attention'?' on':'') + '" data-f="attention">דורש פעולה ' + r.needsAttention + '</button>' +
    '<button class="chip teal' + (FILTER==='referral'?' on':'') + '" data-f="referral">הפניה ' + r.referralReady + '</button>' +
    '<button class="refresh" id="refreshBtn">רענן תובנות</button>';
}

function aggGroup(label, items){
  if (!items || !items.length) return '';
  return '<div class="grp"><div class="grp-lbl">' + label + '</div><ul>' + items.map(i=>'<li>'+esc(i)+'</li>').join('') + '</ul></div>';
}

function renderAgg(agg){
  if (!agg) {
    $('#agg').innerHTML = '<div class="agg"><h2>תובנות מוצר</h2><div class="empty">עדיין לא נוצרו תובנות — לחצו "רענן תובנות" למעלה (דורש מפתח API מוגדר בצד השרת).</div></div>';
    return;
  }
  const body = aggGroup('נושאים חוזרים', agg.recurringThemes) + aggGroup('שימושים נפוצים', agg.commonUseCases) + aggGroup('בעיות חוזרות', agg.recurringProblems);
  $('#agg').innerHTML = '<div class="agg"><h2>תובנות מוצר — על פני כל המשתמשים</h2>' + (body || '<div class="empty">אין עדיין תובנות משמעותיות.</div>') + '</div>';
}

function card(u){
  const cls = u.group === 'attention' ? 'attention' : (u.group === 'referral' ? 'referral' : '');
  const badge = u.group === 'attention'
    ? '<span class="badge risk">סיכון ' + u.churnRisk + '%</span>'
    : (u.group === 'referral' ? '<span class="badge ref">רגע הפניה</span>' : '');
  const meta = [
    u.tenureDays === 0 ? 'הצטרף היום' : 'ותק ' + u.tenureDays + ' ימים',
    u.source ? 'מקור: ' + esc(u.source) : null,
    u.messageCount + ' הודעות',
  ].filter(Boolean).join(' · ');
  const topic = u.topic ? '<div class="topic">' + esc(u.topic) + '</div>' : '';
  const flag = u.awaitingReply ? '<div class="flag">⚠ ממתין לתשובה — לבדוק את הסוכן</div>' : '';
  let act = '';
  if (u.action.text) {
    act = '<div class="act"><div class="txt"><span class="why">' + esc(u.action.why) + '</span>' + esc(u.action.text) +
      '</div><button class="copy" data-copy="' + esc(u.action.text) + '">העתק</button></div>';
  } else if (u.action.type !== 'none') {
    act = '<div class="act info"><div class="txt"><span class="why">' + esc(u.action.why) + '</span></div></div>';
  }
  return '<div class="card ' + cls + '" data-open="' + esc(u.slug) + '">' +
    '<div class="id"><span class="name">' + esc(u.name || u.slug) + '</span>' + badge + '</div>' +
    '<div class="meta">' + meta + '</div>' + topic +
    '<div class="story">' + esc(u.story) + '</div>' + flag + act + '</div>';
}

function userRow(u){
  const when = u.lastMessageDaysAgo === null ? 'לא דיבר' :
    (u.lastMessageDaysAgo === 0 ? 'היום' : 'לפני ' + u.lastMessageDaysAgo + ' ימים');
  const dot = u.group === 'attention' ? '<span style="color:var(--alert)">●</span> ' :
    (u.group === 'referral' ? '<span style="color:var(--teal)">●</span> ' : '<span style="color:var(--faint)">●</span> ');
  return '<div class="row" data-open="' + esc(u.slug) + '">' +
    '<span class="name">' + dot + esc(u.name || u.slug) + '</span>' +
    '<span class="topic">' + esc(u.topic || '') + '</span>' +
    '<span class="when">' + when + '</span>' +
    '</div>';
}

function signupRow(s){
  const when = s.daysAgo === 0 ? 'היום' : 'לפני ' + s.daysAgo + ' ימים';
  return '<div class="row signup">' +
    '<span class="name">' + esc(s.name || 'ללא שם') + '</span>' +
    '<span class="sub">' + (s.phone ? esc(s.phone) : 'ללא טלפון') + (s.source ? ' · ' + esc(s.source) : '') + '</span>' +
    '<span class="when">' + when + '</span></div>';
}

function render(b){
  renderRollup(b.rollup);
  renderAgg(b.aggregateInsights);
  const groups = { attention:[], referral:[], stable:[] };
  for (const u of b.users) groups[u.group].push(u);
  let html = '';
  if (!FILTER || FILTER === 'attention') {
    html += '<section><h2 class="alert">דורש פעולה עכשיו <span class="cnt">(' + groups.attention.length + ')</span></h2>';
    html += groups.attention.length
      ? '<div class="cards">' + groups.attention.map(card).join('') + '</div>'
      : '<div class="empty">נקי — אף אחד לא דורש פעולה כרגע.</div>';
    html += '</section>';
  }
  if (!FILTER || FILTER === 'referral') {
    html += '<section><h2 class="teal">הזדמנות הפניה <span class="cnt">(' + groups.referral.length + ')</span></h2>';
    html += groups.referral.length
      ? '<div class="cards">' + groups.referral.map(card).join('') + '</div>'
      : '<div class="empty">אין כרגע רגע הפניה בשל.</div>';
    html += '</section>';
  }
  if (!FILTER) {
    html += '<section><h2>כל המשתמשים <span class="cnt">(' + b.users.length + ')</span></h2>' +
      '<div class="rows">' + b.users.map(userRow).join('') + '</div></section>';
    if (b.signups.length) {
      html += '<section><h2>נרשמו ולא הפעילו <span class="cnt">(' + b.signups.length + ')</span></h2>' +
        '<div class="rows">' + b.signups.map(signupRow).join('') + '</div></section>';
    }
    if (b.issues.length) {
      const stuck = b.issues.filter(i => i.kind === 'stuck');
      const del = b.issues.filter(i => i.kind === 'deleted');
      html += '<div class="fb"><h2>הפעלות שלא הפכו לסוכן חי</h2><ul>' +
        (stuck.length ? '<li>' + stuck.length + ' נתקעו באמצע ההקמה (' + stuck.map(i=>esc(i.name||'ללא שם')).join(', ') + ') — לבדוק אתם ידנית.</li>' : '') +
        (del.length ? '<li>' + del.length + ' סוכנים נמחקו מאז ההפעלה (' + del.map(i=>esc(i.name||'ללא שם')).join(', ') + ').</li>' : '') +
        '</ul></div>';
    }
    if (b.rollup.templateFeedback.length) {
      html += '<div class="fb"><h2>חזרה לתבנית</h2><ul>' +
        b.rollup.templateFeedback.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div>';
    }
  }
  $('#content').innerHTML = html;
  $('#stamp').textContent = 'עודכן ' + new Date(b.generatedAt).toLocaleTimeString('he-IL', {hour:'2-digit',minute:'2-digit'});
}

const SAT_LABEL = { positive: 'חיובית', neutral: 'ניטרלית', negative: 'שלילית', unknown: 'לא ידוע' };

function dayBlock(d){
  const dateStr = new Date(d.day + 'T12:00:00').toLocaleDateString('he-IL', {day:'numeric', month:'short'});
  const cnt = d.userMessageCount + ' הודעות משתמש' + (d.agentMessageCount ? ' · ' + d.agentMessageCount + ' תשובות' : '');
  const stale = d.fromCache ? '' : '<span class="stale">טרם עודכן</span>';
  return '<div class="day"><div class="dhd"><span>' + dateStr + '</span><span>' + cnt + ' ' + stale + '</span></div>' +
    '<div class="dsum">' + esc(d.summary) + '</div></div>';
}

async function openDetail(slug){
  const ov = $('#overlay');
  ov.classList.add('open');
  $('#dcontent').innerHTML = '<button class="dclose" id="dclose">✕ סגור</button><div class="dempty">טוען…</div>';
  try{
    const r = await fetch('/admin/user/' + encodeURIComponent(slug) + '?key=' + encodeURIComponent(KEY));
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const u = await r.json();
    let html = '<button class="dclose" id="dclose">✕ סגור</button>';
    html += '<div class="dhead"><div class="name">' + esc(u.name || u.slug) + '</div>' +
      '<div class="meta">' + u.totalUserMessages + ' הודעות סה"כ · ' + u.days.length + ' ימים פעילים' +
      (u.insightsGeneratedAt ? ' · תובנות מ-' + new Date(u.insightsGeneratedAt).toLocaleDateString('he-IL') : ' · תובנות ראשוניות, טרם נוצרו על ידי AI') + '</div></div>';
    html += '<div class="dtopic">' + esc(u.topic) + '</div>';

    let ins = '';
    if (u.whatWorks) ins += '<div class="dins"><div class="lbl">מה עובד</div>' + esc(u.whatWorks) + '</div>';
    if (u.whatsStuck) ins += '<div class="dins stuck"><div class="lbl">תקוע / פתוח</div>' + esc(u.whatsStuck) + '</div>';
    ins += '<div class="dins"><div class="lbl">שביעות רצון</div>' + esc(SAT_LABEL[u.satisfaction] || u.satisfaction) + '</div>';
    if (u.referralMoment) ins += '<div class="dins referral"><div class="lbl">רגע הפניה</div>' + esc(u.referralMoment) + '</div>';
    if (ins) html += '<div class="dinsights">' + ins + '</div>';
    if (u.qualityFlags && u.qualityFlags.length) {
      html += '<div class="dflags">' + u.qualityFlags.map(f => '<span class="dflag">⚠ ' + esc(f) + '</span>').join('') + '</div>';
    }

    if (u.quotes && u.quotes.length) {
      html += '<div class="dsec"><h3>בקול שלו/ה</h3>' +
        u.quotes.map(q => '<div class="quote">״' + esc(q.text) + '״<span class="when">' +
          new Date(q.ms).toLocaleDateString('he-IL', {day:'numeric', month:'short'}) + '</span></div>').join('') + '</div>';
    }

    if (u.days && u.days.length) {
      html += '<div class="dsec"><h3>ציר זמן</h3>' + u.days.slice().reverse().map(dayBlock).join('') + '</div>';
    } else {
      html += '<div class="dempty">אין עדיין הודעות מהמשתמש הזה.</div>';
    }

    $('#dcontent').innerHTML = html;
  }catch(e){
    $('#dcontent').innerHTML = '<button class="dclose" id="dclose">✕ סגור</button><div class="dempty">שגיאה בטעינה: ' + esc(e.message) + '</div>';
  }
}

function closeDetail(){ $('#overlay').classList.remove('open'); }

let BOARD = null;
async function load(){
  try{
    const r = await fetch('/admin/users-board?key=' + encodeURIComponent(KEY));
    if(!r.ok) throw new Error('HTTP ' + r.status);
    BOARD = await r.json();
    render(BOARD);
  }catch(e){
    const el = $('#err'); el.style.display='block'; el.textContent = 'שגיאה בטעינה: ' + e.message;
  }
}

async function doRefresh(){
  const btn = $('#refreshBtn');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'מרענן…';
  try{
    const r = await fetch('/admin/users-board/refresh?key=' + encodeURIComponent(KEY), { method: 'POST' });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error || ('HTTP ' + r.status));
    if (!result.hadApiKey) {
      toast('אין מפתח API מוגדר בצד השרת — לא נוצרו תובנות AI');
    } else {
      toast('נוצרו ' + result.daysGenerated + ' סיכומי יום חדשים');
    }
    await load();
  }catch(e){
    toast('רענון נכשל: ' + e.message);
  } finally {
    if ($('#refreshBtn')) { $('#refreshBtn').disabled = false; $('#refreshBtn').textContent = 'רענן תובנות'; }
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#dclose')) { closeDetail(); return; }
  if (e.target.closest('#refreshBtn')) { doRefresh(); return; }
  const c = e.target.closest('button[data-copy]');
  if (c) { copyText(c.dataset.copy, c); return; }
  const f = e.target.closest('button[data-f]');
  if (f && BOARD) { FILTER = FILTER === f.dataset.f ? null : f.dataset.f; render(BOARD); return; }
  const opener = e.target.closest('[data-open]');
  if (opener) { openDetail(opener.dataset.open); return; }
});

load();
</script>
</body>
</html>`;
}
