#!/usr/bin/env node
// a4j-board-mcp v0.5 — lets the job agent read/write its own user's board.
// v0.5 (2026-10-05): CV vault — list_cvs, save_cv (a CV file the user sent on
// WhatsApp goes to the vault), and mark_applied requires cvId (which CV was sent).
// v0.4 (2026-10-05): decision tools mark_applied / mark_not_fit / mark_closed —
// the same records as the board's decision buttons, so a decision made in chat
// counts toward the batch of 10 and the job is not offered again. search_jobs: LinkedIn for pilots.
// v0.3 (2026-10-04): search_jobs (on-demand search) + log_contact_message.
// Zero dependencies (plain JSON-RPC over stdio) so it runs in any pilot container.
// Auth: the user's scoped boardToken from /workspace/agent/.agent4job.json (written
// at provision), sent as a Bearer header. The server resolves the user from it.
// Never applies, submits or contacts anyone: board info only.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const FEED = process.env.A4J_FEED_URL || 'http://172.17.0.1:8080';
const CONFIG = process.env.A4J_CONFIG || '/workspace/agent/.agent4job.json';

function boardToken() {
  if (process.env.A4J_BOARD_TOKEN) return process.env.A4J_BOARD_TOKEN;
  const t = JSON.parse(readFileSync(CONFIG, 'utf8')).boardToken;
  if (!t) throw new Error('no boardToken in ' + CONFIG);
  return t;
}

async function api(method, path, body) {
  const r = await fetch(FEED + path, {
    method,
    headers: { Authorization: 'Bearer ' + boardToken(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${json.error || text.slice(0, 300)}`);
  return json;
}

const STAGES = ['none', 'to_apply', 'applied', 'phone_screen', 'interview', 'final', 'offer', 'rejected', 'withdrawn'];

// Decision tools (v0.4). Each writes the same records as the board's decision
// buttons: applied = tracking stage applied + positive vote; not_fit = negative
// vote + reason; closed = negative vote coded filled-closed (nothing learned) +
// the shared closed registry. Every decided job leaves the matches list.
const NOT_FIT_CODES = ['off-function', 'off-sector', 'too-senior', 'location', 'missing-requirement', 'other'];

// CV vault (v0.5). Files arrive in /workspace/inbox/<msg>/<file>; only those may be uploaded.
const INBOX = process.env.A4J_INBOX || '/workspace/inbox';
const CV_MAX = 8 * 1024 * 1024;
function sniffCv(buf) {
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 && buf.includes('word/')) return 'docx';
  return null;
}
async function saveCv(a) {
  let real;
  try { real = realpathSync(String(a.path || '')); } catch { throw new Error('file not found: ' + a.path); }
  const inbox = (() => { try { return realpathSync(INBOX); } catch { return INBOX; } })();
  if (!real.startsWith(inbox + '/')) throw new Error('only files the user sent (under ' + INBOX + '/) can be saved');
  if (statSync(real).size > CV_MAX) throw new Error('file too large (max 8MB)');
  const buf = readFileSync(real);
  const ext = sniffCv(buf);
  if (!ext) throw new Error('not a PDF or Word (.docx) file — ask the user to send the CV as PDF or .docx');
  const label = String(a.label || '').trim().slice(0, 80);
  const r = await fetch(`${FEED}/agent/cvs?ext=${ext}&origin=whatsapp${label ? '&label=' + encodeURIComponent(label) : ''}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + boardToken(), 'Content-Type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(30000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST /agent/cvs -> ${r.status}: ${json.error || ''}`);
  return json;
}

async function markApplied(a) {
  const cvId = String(a.cvId || '').trim();
  if (!cvId) throw new Error('cvId is required: ask the user which CV they sent (list_cvs), or use "unknown" if they do not remember');
  const track = await api('POST', '/agent/track', { jobId: a.jobId, stage: 'applied', cvId, ...(a.notes ? { notes: a.notes } : {}), ...(a.nextAction ? { nextAction: a.nextAction } : {}), ...(a.followUpAt ? { followUpAt: a.followUpAt } : {}) });
  // No reason text: an un-coded vote learns its reason words, and "applied" words say nothing about fit.
  const vote = await api('POST', '/feedback', { jobId: a.jobId, fit: 'up' });
  return { ok: true, decision: 'applied', jobId: a.jobId, stage: 'applied', track, vote };
}

async function markNotFit(a) {
  if (a.reasonCode === 'missing-requirement' && !String(a.requirement || '').trim()) throw new Error('requirement text is required for missing-requirement');
  const reason = [a.requirement, a.reason].map((s) => String(s || '').trim()).filter(Boolean).join(' · ').slice(0, 300);
  const vote = await api('POST', '/feedback', { jobId: a.jobId, fit: 'down', reasonCodes: [a.reasonCode], reason });
  return { ok: true, decision: 'not_fit', jobId: a.jobId, vote };
}

async function markClosed(a) {
  const vote = await api('POST', '/feedback', { jobId: a.jobId, fit: 'down', reasonCodes: ['filled-closed'], reason: String(a.evidence || 'המשרה נסגרה').slice(0, 300) });
  // Shared registry is best-effort: the user's own decision is already saved.
  let shared;
  try { shared = await api('POST', '/agent/closed', { jobId: a.jobId, reason: String(a.evidence || '').slice(0, 200) }); }
  catch (e) { shared = { ok: false, error: String(e.message || e).slice(0, 200) }; }
  return { ok: true, decision: 'closed', jobId: a.jobId, vote, shared };
}

const TOOLS = [
  {
    name: 'mark_applied',
    description: "Record that the USER sent an application for this job (they told you they applied). Sets the tracking stage to applied, records which CV was sent, and records a positive vote; the job moves to Tracking and counts as a decision in the batch of 10. Only when the user said they actually sent it; never because they plan to, and drafting a message is not sending. jobId = the job URL from list_board_jobs. BEFORE calling, ask which CV they sent: call list_cvs; if there is exactly one, confirm it in one short question; if several, list their labels; if the user sends the file now, save it with save_cv and use its id; if they don't remember, cvId=\"unknown\".",
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        cvId: { type: 'string', description: 'id from list_cvs / save_cv, or "unknown" if the user does not remember' },
        notes: { type: 'string', description: 'optional, e.g. how/where they applied' },
        nextAction: { type: 'string' },
        followUpAt: { type: 'string', description: 'ISO date' },
      },
      required: ['jobId', 'cvId'],
      additionalProperties: false,
    },
    run: markApplied,
  },
  {
    name: 'list_cvs',
    description: "List the user's saved CV files (their personal CV vault on the board): id, label, ext, origin, createdAt. Use it to ask which CV they sent before mark_applied, and to tell them what is saved.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/agent/cvs'),
  },
  {
    name: 'save_cv',
    description: "Save a CV file the user sent in this chat into their CV vault (shown on the board under קורות החיים שלי). Only for an actual CV/resume file (PDF or .docx) — never voice notes, images or other documents. path = the file under /workspace/inbox/. label = a short name in the user's words, e.g. «עברית · ניהול מוצר» or «English CV». Identical files are not duplicated (deduped=true). Tell the user it is saved only after success.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'absolute path of the received file, under /workspace/inbox/' },
        label: { type: 'string', description: 'short name, up to 80 chars' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: saveCv,
  },
  {
    name: 'mark_not_fit',
    description: "Record that the job does not fit the user / they will not apply, with ONE main reason. reasonCode: off-function (role type), off-sector (company field), too-senior, location, missing-requirement (the user lacks a must-have requirement; put it in `requirement` in the user's words, short, e.g. «5 שנות ניסיון במכירות SaaS»), other (explain in `reason`). The job leaves the list and the reason calibrates the next batch. Ask the user for the reason if they did not give one.",
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        reasonCode: { type: 'string', enum: NOT_FIT_CODES },
        requirement: { type: 'string', description: 'required for missing-requirement, up to 120 chars' },
        reason: { type: 'string', description: 'optional free text, up to 300 chars' },
      },
      required: ['jobId', 'reasonCode'],
      additionalProperties: false,
    },
    run: markNotFit,
  },
  {
    name: 'mark_closed',
    description: "Record that the posting is closed / the role was filled (the user saw it says so, or the page is gone). Removes the job from the user's list and reports it to the shared closed list; nothing is learned about the user's preferences. Not for jobs the user simply doesn't want (use mark_not_fit).",
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        evidence: { type: 'string', description: 'short, e.g. "the posting says the position is filled"' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    run: markClosed,
  },
  {
    name: 'list_board_jobs',
    description: "Read the user's board: ranked jobs from the scan plus jobs added by the agent or user, with status, starred and tracking. Call before acting and after every write to verify.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/agent/jobs'),
  },
  {
    name: 'add_job_to_board',
    description: "Add a job posting URL to the user's board (saved as agent-added). For a URL returned by search_jobs in the last 2 hours the server stores the real title/company from the search; otherwise it fetches the page, and if it cannot, the row is kept with needsReview=true. Never invent details. Does not apply.",
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'http(s) job posting URL' } }, required: ['url'], additionalProperties: false },
    run: (a) => api('POST', '/agent/add-job', { url: a.url, origin: 'agent-added' }),
  },
  {
    name: 'search_jobs',
    description: "Search for new job postings for the user right now (LinkedIn public listings, read-only; job boards only where enabled for this user). Returns up to `limit` results with url/title/company/location/source and onBoard=true if already on the board. Nothing is added automatically: show the user the relevant ones and add the chosen ones with add_job_to_board. Rate-limited (one search per 15s, 40 per day); on 'search too soon' wait retryAfterSec. Use precise role keywords (English or Hebrew), one search per distinct query.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'role keywords, 2-80 chars, e.g. "Partnerships Manager" or "מנהל שיווק"' },
        location: { type: 'string', description: 'LinkedIn location, default "Israel" (e.g. "Tel Aviv")' },
        sources: { type: 'array', items: { type: 'string', enum: ['linkedin', 'drushim'] }, description: 'omit to search every source enabled for this user' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: (a) => api('POST', '/agent/search', a),
  },
  {
    name: 'log_contact_message',
    description: "Append one entry to the correspondence log of a job (who wrote to whom, when, over which channel, and a short summary). Use it whenever the user tells you about an email/message/call/meeting with a contact about a job, or asks you to record one. Append-only; set the job's contact itself with track_job.contact. Record only what the user told you.",
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'job URL from list_board_jobs' },
        direction: { type: 'string', enum: ['in', 'out'], description: 'in = the contact wrote/called the user; out = the user wrote/called the contact' },
        channel: { type: 'string', enum: ['email', 'linkedin', 'phone', 'whatsapp', 'meeting', 'other'] },
        summary: { type: 'string', description: 'short factual summary, up to 1000 chars' },
        at: { type: 'string', description: 'ISO date/time of the message; default now' },
        contactName: { type: 'string', description: 'name of the person, if different from the job contact' },
      },
      required: ['jobId', 'direction', 'channel', 'summary'],
      additionalProperties: false,
    },
    run: (a) => api('POST', '/agent/contact-log', a),
  },
  {
    name: 'star_job',
    description: 'Star or unstar a job on the board (jobId = the job URL from list_board_jobs).',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, starred: { type: 'boolean' } }, required: ['jobId', 'starred'], additionalProperties: false },
    run: (a) => api('POST', '/agent/star', { jobId: a.jobId, starred: a.starred }),
  },
  {
    name: 'track_job',
    description: 'Update the application pipeline of a job. stage drives the board status chip automatically. Record only what the user told you; never mark applied unless it happened.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        stage: { type: 'string', enum: STAGES },
        notes: { type: 'string' },
        nextAction: { type: 'string' },
        followUpAt: { type: 'string', description: 'ISO date' },
        contact: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, role: { type: 'string' } }, additionalProperties: false },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    run: (a) => api('POST', '/agent/track', a),
  },
  {
    name: 'set_job_status',
    description: "Mark a job as interested on the board. For a final decision use mark_applied / mark_not_fit / mark_closed instead (they count toward the batch); not_relevant here is kept only for old flows.",
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, status: { type: 'string', enum: ['interested', 'not_relevant'] } }, required: ['jobId', 'status'], additionalProperties: false },
    run: (a) => api('POST', '/status', { jobId: a.jobId, status: a.status }),
  },
  {
    name: 'get_board_status',
    description: 'Scan and board status: last scan time, schedule, whether ranking is building now, ranked and added counts. Use it to tell the user truthfully what the scan found and when the next one runs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/agent/status'),
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'a4j-board', version: '0.5.0' },
    } });
  }
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params?.name } });
    try {
      const out = await tool.run(params.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } });
    }
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  handle(req);
});
