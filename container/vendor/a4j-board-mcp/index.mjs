#!/usr/bin/env node
// a4j-board-mcp v0.3 — lets the job agent read/write its own user's board.
// v0.3 (2026-10-04): search_jobs (on-demand search) + log_contact_message.
// Zero dependencies (plain JSON-RPC over stdio) so it runs in any pilot container.
// Auth: the user's scoped boardToken from /workspace/agent/.agent4job.json (written
// at provision), sent as a Bearer header. The server resolves the user from it.
// Never applies, submits or contacts anyone: board info only.
import { readFileSync } from 'node:fs';
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

const TOOLS = [
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
    description: "Search for new job postings for the user right now (LinkedIn + Drushim, public listings, read-only). Returns up to `limit` results with url/title/company/location/source and onBoard=true if already on the board. Nothing is added automatically: show the user the relevant ones and add the chosen ones with add_job_to_board. Rate-limited (one search per 15s, 40 per day); on 'search too soon' wait retryAfterSec. Use precise role keywords (English or Hebrew), one search per distinct query.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'role keywords, 2-80 chars, e.g. "Partnerships Manager" or "מנהל שיווק"' },
        location: { type: 'string', description: 'LinkedIn location, default "Israel" (e.g. "Tel Aviv")' },
        sources: { type: 'array', items: { type: 'string', enum: ['linkedin', 'drushim'] } },
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
    description: "Mark a job as interested or not_relevant on the board. Other statuses come from track_job stage.",
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
      serverInfo: { name: 'a4j-board', version: '0.3.0' },
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
