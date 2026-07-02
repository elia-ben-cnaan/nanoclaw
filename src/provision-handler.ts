/**
 * POST /provision — per-user agent provisioning for the NanoCo pilot.
 *
 * Receives a registration payload from the signup app (nanohubdemo.vercel.app),
 * spins a new isolated NanoClaw agent for the user, mints a Telegram pairing
 * code on the shared @shellanoo_bot, and returns the deep-link so the user
 * can complete onboarding in one tap.
 *
 * Expected body (JSON):
 *   { name, phone, email, gender, lang, ts }
 *
 * Optional header:
 *   Authorization: Bearer <HOST_PROVISION_TOKEN>
 *
 * Returns:
 *   200  { "deepLink": "https://t.me/shellanoo_bot?start=<code>" }
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
import { createPairing } from './channels/telegram-pairing.js';
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

const TEMPLATE_PATH = path.join(GROUPS_DIR, 'dm-with-elia-ben-cnaan', 'hosted_agent_template.md');

/**
 * Warm, non-technical default name every freshly-provisioned pilot introduces
 * itself with. This is the user-facing display name + the agent's own name
 * (`assistant_name`) — NOT the slug. The slug (`generateSlug()`) stays an
 * internal id only: it's the folder, the supervisor-wiring local_name, and the
 * log key, and is never surfaced to the user. The user can rename the agent at
 * any time ("call me anything you like"); the agent then adopts the new name
 * and persists it (see hosted_agent_template.md → "## איך קוראים לי").
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
const PILOT_DAILY_COST_CAP_USD = 1.0;

// Resolved once at startup from the pilot bot token via getMe.
const PILOT_BOT_USERNAME_PROMISE: Promise<string> = (async () => {
  const env = readEnvFile(['PILOT_TELEGRAM_BOT_TOKEN']);
  const token = env['PILOT_TELEGRAM_BOT_TOKEN'];
  if (!token) return 'banielaclowbot'; // fallback until pilot bot is configured
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return data.ok && data.result?.username ? data.result.username : 'banielaclowbot';
  } catch {
    return 'banielaclowbot';
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
  const lang = typeof body.lang === 'string' ? body.lang : 'he';

  try {
    // 3. Choose a unique slug / folder
    let slug = generateSlug();
    let attempts = 0;
    while (getAgentGroupByFolder(slug) && attempts++ < 20) {
      slug = generateSlug();
    }

    // 4. Create the agent group. Display name = warm default (never the slug);
    //    folder = slug, which stays the internal id only.
    const agentGroupId = `ag-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    createAgentGroup({
      id: agentGroupId,
      name: DEFAULT_ASSISTANT_NAME,
      folder: slug,
      agent_provider: null,
      created_at: now,
    });

    // 5. Initialize filesystem with the seeded instructions
    const instructions =
      buildUserIdentityBlock(userName, gender, lang) +
      '\n\n' +
      buildInstructions(userName, 'Telegram', DEFAULT_ASSISTANT_NAME);
    initGroupFilesystem(
      { id: agentGroupId, name: DEFAULT_ASSISTANT_NAME, folder: slug, agent_provider: null, created_at: now },
      { instructions },
    );

    // 6. Set model + pilot cost config (LOCKED, see PILOT_MODEL /
    //    PILOT_DAILY_COST_CAP_USD). Model goes into container_configs; the daily
    //    cap is written as a per-agent agent_cost_caps row so it is pinned in
    //    the DB and the router's isOverDailyCostCap gate enforces it from the
    //    first turn, independent of the env default.
    ensureContainerConfig(agentGroupId);
    updateContainerConfigScalars(agentGroupId, {
      model: PILOT_MODEL,
      assistant_name: DEFAULT_ASSISTANT_NAME,
    });
    setCostCapUsd(agentGroupId, PILOT_DAILY_COST_CAP_USD);

    // 6b. Wire the pilot bidirectionally to Daniela (supervisor visibility +
    //     reachability). Applies automatically to every provisioned agent.
    wirePilotToSupervisor(agentGroupId, slug);

    // 7. Mint a Telegram pairing code
    const pairing = await createPairing({ kind: 'new-agent', folder: slug, lang, userName });
    const code = pairing.code;

    // 8. Build and return the deep-link
    const botUsername = await PILOT_BOT_USERNAME_PROMISE;
    const deepLink = `https://t.me/${botUsername}?start=${code}`;
    log.info('Provision: agent created', { slug, agentGroupId, userName, code });
    json(res, 200, { deepLink });
  } catch (err) {
    log.error('Provision: failed', { err, userName });
    json(res, 500, { error: 'Internal error' });
  }
}
