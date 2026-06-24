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
import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { readEnvFile } from './env.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { createPairing } from './channels/telegram-pairing.js';

const PROVISION_TOKEN: string | undefined = (() => {
  const fromEnv = readEnvFile(['HOST_PROVISION_TOKEN']);
  return fromEnv['HOST_PROVISION_TOKEN'] || process.env['HOST_PROVISION_TOKEN'] || undefined;
})();

const TEMPLATE_PATH = path.join(GROUPS_DIR, 'dm-with-elia-ben-cnaan', 'hosted_agent_template.md');

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

function buildInstructions(userName: string, channel: string): string {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template.replaceAll('{{USER_NAME}}', userName).replaceAll('{{CHANNEL}}', channel);
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

    // 4. Create the agent group
    const agentGroupId = `ag-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    createAgentGroup({ id: agentGroupId, name: slug, folder: slug, agent_provider: null, created_at: now });

    // 5. Initialize filesystem with the seeded instructions
    const instructions =
      buildUserIdentityBlock(userName, gender, lang) + '\n\n' + buildInstructions(userName, 'Telegram');
    initGroupFilesystem(
      { id: agentGroupId, name: slug, folder: slug, agent_provider: null, created_at: now },
      { instructions },
    );

    // 6. Set model + pilot config
    ensureContainerConfig(agentGroupId);
    updateContainerConfigScalars(agentGroupId, { model: 'claude-sonnet-4-6', assistant_name: 'נאנו' });

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
