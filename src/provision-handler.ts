/**
 * POST /provision — pilot registration (activation v2, deep-link codes).
 *
 * Receives a registration payload from the signup app, mints a one-time
 * 20-char activation code (24h TTL) and returns the Telegram deep-link.
 * NOTHING is created at registration time: the agent is provisioned when
 * the user actually presses START (provisionPilotAtPress below), and binds
 * to the Telegram identity of whoever pressed — never to the phone/email
 * from the form, which stay contact metadata on the activation row. This
 * also kills the orphan-agent problem (registrations that never press).
 *
 * Expected body (JSON):
 *   { name, phone, email, gender, lang, ts }
 *
 * Optional header:
 *   Authorization: Bearer <HOST_PROVISION_TOKEN>
 *
 * Returns:
 *   200  { "deepLink": "https://t.me/<pilot-bot>?start=<code>" }
 *   401  { "error": "Unauthorized" }
 *   400  { "error": "Bad request" }
 *   500  { "error": "Internal error" }
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { setCostCapUsd } from './db/usage-metering.js';
import { findSessionByAgentGroup } from './db/sessions.js';
import { readEnvFile } from './env.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import {
  createActivation,
  PILOT_WINDOW_DAYS,
  type PilotActivation,
  type PilotLang,
} from './modules/pilot-activation/db.js';
import { createDestination, getDestinationByName } from './modules/agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from './modules/agent-to-agent/write-destinations.js';

/**
 * Daniela — the supervisor agent group. Every pilot agent provisioned here is
 * wired bidirectionally to her so she can (a) read the user↔agent conversation
 * (via the mirror in telegram-pilot.ts) and (b) reach any specific pilot if a
 * problem comes up. Same install / same central DB as the pilots, so this is a
 * plain shared-backbone destination wiring — identical to what `create_agent`
 * does for parent↔child.
 */
const SUPERVISOR_AGENT_GROUP_ID = 'ag-1780401001748-zriukn';

/**
 * Wire a freshly-provisioned pilot agent bidirectionally to Daniela.
 *   Daniela → pilot : local_name = slug   (lets Daniela message this agent)
 *   pilot   → Daniela: local_name = parent (lets the pilot escalate upward)
 *
 * Mirrors the create_agent destination convention. Best-effort: a wiring
 * failure must never break provisioning, so everything is wrapped and logged.
 */
function wirePilotToSupervisor(pilotGroupId: string, slug: string): void {
  try {
    const supervisor = getAgentGroup(SUPERVISOR_AGENT_GROUP_ID);
    if (!supervisor) {
      log.warn('Provision: supervisor agent group not found, skipping wiring', {
        supervisor: SUPERVISOR_AGENT_GROUP_ID,
        slug,
      });
      return;
    }
    const now = new Date().toISOString();

    // Daniela → pilot
    if (!getDestinationByName(SUPERVISOR_AGENT_GROUP_ID, slug)) {
      createDestination({
        agent_group_id: SUPERVISOR_AGENT_GROUP_ID,
        local_name: slug,
        target_type: 'agent',
        target_id: pilotGroupId,
        created_at: now,
      });
    }

    // pilot → Daniela (canonical "parent", deduped just like create_agent)
    let parentName = 'parent';
    let suffix = 2;
    while (getDestinationByName(pilotGroupId, parentName)) {
      parentName = `parent-${suffix}`;
      suffix++;
    }
    createDestination({
      agent_group_id: pilotGroupId,
      local_name: parentName,
      target_type: 'agent',
      target_id: SUPERVISOR_AGENT_GROUP_ID,
      created_at: now,
    });

    // Project the new destination into Daniela's RUNNING container so she can
    // message the pilot immediately (destination-projection invariant — see
    // agent-destinations.ts). The pilot's own projection is written on its
    // first container wake, so it needs no refresh here.
    const supSession = findSessionByAgentGroup(SUPERVISOR_AGENT_GROUP_ID);
    if (supSession) writeDestinations(SUPERVISOR_AGENT_GROUP_ID, supSession.id);

    log.info('Provision: wired pilot to supervisor', { slug, pilotGroupId, parentName });
  } catch (err) {
    log.warn('Provision: failed to wire pilot to supervisor', { err, slug, pilotGroupId });
  }
}

const PROVISION_TOKEN: string | undefined = (() => {
  const fromEnv = readEnvFile(['HOST_PROVISION_TOKEN']);
  return fromEnv['HOST_PROVISION_TOKEN'] || process.env['HOST_PROVISION_TOKEN'] || undefined;
})();

// Johnny (ג'וני) is the active pilot agent as of 2026-07-06: every provisioned
// agent is born from this approved v2 script (Elia #16256). Replaces the older
// hosted_agent_template.md (ג'ני). Existing Jenny agents keep their own files.
const TEMPLATE_PATH = path.join(GROUPS_DIR, 'dm-with-elia-ben-cnaan', 'pilot_agent_script_v2.md');

/**
 * Fixed name every pilot agent introduces itself with (per the pilot spec:
 * a single, consistent identity — no rename invitation in the greeting).
 * This is the user-facing display name + the agent's own name
 * (`assistant_name`) — NOT the slug. The slug (`generateSlug()`) stays an
 * internal id only: it's the folder, the supervisor-wiring local_name, and
 * the log key, and is never surfaced to the user.
 */
const DEFAULT_ASSISTANT_NAME = "ג'וני";

/**
 * Pilot cost config — LOCKED. Every freshly-provisioned hosted agent is pinned
 * to this model and this daily USD spend cap. Both are written at create time:
 * the model into container_configs, the cap into agent_cost_caps as a per-agent
 * row so it holds in the DB regardless of the PILOT_DAILY_COST_CAP_USD env
 * default and never drifts. The provision request body carries no model or cost
 * fields, so a caller cannot raise either. Change the pilot tier here, in one
 * place, not per request.
 */
const PILOT_MODEL = 'claude-haiku-4-5';
// Overflow provider for pilots: when the Claude account hits its plan/session
// limit, the pilot keeps answering via Codex instead of surfacing a raw
// "session limit" error to the user (and returns to Claude automatically when
// quota renews). Mirrors Daniela's config so app-created agents survive an
// outage the same way.
const PILOT_FALLBACK_PROVIDER = 'codex';
const PILOT_DAILY_COST_CAP_USD = 1.0;

// Resolved once at startup from the Johnny bot token via getMe. The /provision
// deep link points at @joni_agent_bot as of 2026-07-06 (Johnny replaces the
// pilot in provisioning). Falls back to the literal username if getMe fails.
const PILOT_BOT_USERNAME_PROMISE: Promise<string> = (async () => {
  const env = readEnvFile(['JONI_TELEGRAM_BOT_TOKEN']);
  const token = env['JONI_TELEGRAM_BOT_TOKEN'];
  if (!token) return 'joni_agent_bot'; // fallback until Johnny bot token is set
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return data.ok && data.result?.username ? data.result.username : 'joni_agent_bot';
  } catch {
    return 'joni_agent_bot';
  }
})();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function generateSlug(): string {
  return 'pilot-' + crypto.randomBytes(3).toString('hex'); // e.g. pilot-a3f9c2
}

function buildUserIdentityBlock(name: string, gender: string, lang: string): string {
  if (lang === 'en') {
    const genderWord = gender === 'f' ? 'feminine' : 'masculine';
    return (
      `## User identity\n` +
      `The user's name is ${name}. Always address them by this name. ` +
      `Speak to them in Hebrew ${genderWord} grammatical form (gender = ${gender === 'f' ? 'f' : 'm'}).`
    );
  }
  const formHe = gender === 'f' ? 'נקבית' : 'זכרית';
  return (
    `## זהות המשתמש\n` +
    `שם המשתמש הוא ${name}. פנה אליו/אליה תמיד בשמו/שמה. ` +
    `דבר/י אליו/אליה בעברית, בצורה ${formHe} (מין: ${gender === 'f' ? 'נקבה' : 'זכר'}).`
  );
}

function buildInstructions(userName: string, channel: string, assistantName: string): string {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replaceAll('{{USER_NAME}}', userName)
    .replaceAll('{{CHANNEL}}', channel)
    .replaceAll('{{ASSISTANT_NAME}}', assistantName);
}

export async function handleProvision(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // 1. Validate Bearer token if HOST_PROVISION_TOKEN is set
  const expectedToken = PROVISION_TOKEN;
  if (expectedToken) {
    const authHeader = req.headers['authorization'] ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!provided || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expectedToken))) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  // 2. Parse body
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Bad request' });
    return;
  }

  const userName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'User';
  const gender = typeof body.gender === 'string' ? body.gender : 'm';
  const lang: PilotLang = body.lang === 'en' ? 'en' : 'he';

  try {
    // Mint a one-time activation code (24h TTL). The agent itself is created
    // only when the user presses START — see provisionPilotAtPress.
    const activation = createActivation({
      lang,
      metadata: {
        name: userName,
        gender,
        phone: typeof body.phone === 'string' ? body.phone : null,
        email: typeof body.email === 'string' ? body.email : null,
      },
    });

    const botUsername = await PILOT_BOT_USERNAME_PROMISE;
    const deepLink = `https://t.me/${botUsername}?start=${activation.code}`;
    log.info('Provision: activation created', { code: activation.code, userName, lang });
    json(res, 200, { deepLink });
  } catch (err) {
    log.error('Provision: failed', { err, userName });
    json(res, 500, { error: 'Internal error' });
  }
}

/** Contact metadata captured by the signup form (never used for routing). */
interface ActivationMetadata {
  name?: string | null;
  gender?: string | null;
  phone?: string | null;
  email?: string | null;
}

function parseActivationMetadata(activation: PilotActivation): ActivationMetadata {
  try {
    return activation.metadata ? (JSON.parse(activation.metadata) as ActivationMetadata) : {};
  } catch {
    return {};
  }
}

/** One line the agent can answer "when does my pilot end?" from. */
function pilotWindowBlock(lang: PilotLang, pilotEndsAt: string | null): string {
  const endDate = (pilotEndsAt ?? '').slice(0, 10) || 'unknown';
  return lang === 'en'
    ? `## Pilot window\nThis is a ${PILOT_WINDOW_DAYS}-day pilot. The pilot window ends on ${endDate}. If asked how long the pilot lasts or when it ends, answer from this date.`
    : `## תקופת הפיילוט\nזהו פיילוט של ${PILOT_WINDOW_DAYS} ימים. תקופת הפיילוט מסתיימת בתאריך ${endDate}. אם שואלים כמה זמן הפיילוט נמשך או מתי הוא מסתיים — עני לפי התאריך הזה.`;
}

export interface PressProvisionResult {
  agentGroupId: string;
  slug: string;
  userName: string;
  lang: PilotLang;
}

/**
 * Press-time provisioning — everything handleProvision used to do up front,
 * now deferred to the moment the user presses START in Telegram. Creates the
 * agent group (fixed name ג'ני), seeds instructions (user identity + pilot
 * window + hosted template), pins the pilot model + daily cost cap, and wires
 * the agent to the supervisor. Chat-side wiring (messaging group, membership,
 * greeting) stays with the caller in telegram-pilot.ts.
 */
export function provisionPilotAtPress(input: {
  activation: PilotActivation;
  /** Telegram profile name — fallback when the form carried no name. */
  fallbackName?: string | null;
}): PressProvisionResult {
  const meta = parseActivationMetadata(input.activation);
  const userName = meta.name?.trim() || input.fallbackName?.trim() || 'User';
  const gender = meta.gender === 'f' ? 'f' : 'm';
  const lang: PilotLang = input.activation.lang === 'en' ? 'en' : 'he';

  // Unique slug / folder — internal id only, never user-facing.
  let slug = generateSlug();
  let attempts = 0;
  while (getAgentGroupByFolder(slug) && attempts++ < 20) {
    slug = generateSlug();
  }

  const agentGroupId = `ag-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  createAgentGroup({
    id: agentGroupId,
    name: DEFAULT_ASSISTANT_NAME,
    folder: slug,
    agent_provider: null,
    created_at: now,
  });

  const instructions =
    buildUserIdentityBlock(userName, gender, lang) +
    '\n\n' +
    pilotWindowBlock(lang, input.activation.pilot_ends_at) +
    '\n\n' +
    buildInstructions(userName, 'Telegram', DEFAULT_ASSISTANT_NAME);
  initGroupFilesystem(
    { id: agentGroupId, name: DEFAULT_ASSISTANT_NAME, folder: slug, agent_provider: null, created_at: now },
    { instructions },
  );

  // Pilot cost config (LOCKED, see PILOT_MODEL / PILOT_DAILY_COST_CAP_USD).
  ensureContainerConfig(agentGroupId);
  updateContainerConfigScalars(agentGroupId, {
    model: PILOT_MODEL,
    fallback_provider: PILOT_FALLBACK_PROVIDER,
    assistant_name: DEFAULT_ASSISTANT_NAME,
  });
  setCostCapUsd(agentGroupId, PILOT_DAILY_COST_CAP_USD);

  // Supervisor visibility + reachability.
  wirePilotToSupervisor(agentGroupId, slug);

  log.info('Provision: pilot agent created at press', { slug, agentGroupId, userName, lang });
  return { agentGroupId, slug, userName, lang };
}
