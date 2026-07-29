/**
 * Telegram channel adapter for the dedicated NanoCo "Johnny" (ג'וני) bot.
 *
 * The active pilot bot as of 2026-07-06 — @joni_agent_bot. Structurally a
 * sibling of telegram-pilot.ts but:
 *  - Reads JONI_TELEGRAM_BOT_TOKEN (separate bot; @Nanoco_pilot_bot keeps
 *    running on PILOT_TELEGRAM_BOT_TOKEN, serving its existing agents).
 *  - Registers as channel type "telegram-joni" so its messaging groups are
 *    namespaced away from both the main Telegram channel and the old pilot.
 *  - Provisions on EVERY /start: a deep-link `/start <code>` (minted by
 *    /provision from the signup form) carries the registered name/lang; a
 *    bare `/start` (no code) mints an activation on the fly and provisions a
 *    Johnny agent with the Telegram profile name. Either way the agent is
 *    born from the approved v2 script (see provision-handler.ts TEMPLATE_PATH)
 *    and introduces itself as ג'וני.
 *
 * Provisioning itself (agent group, model/cost pinning, supervisor wiring)
 * is shared with the old pilot via provisionPilotAtPress in
 * provision-handler.ts — Johnny simply IS the provisioning default now.
 */
import crypto from 'crypto';

import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';

import { getAgentGroup } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import { findSessionByAgentGroup } from '../db/sessions.js';
import { writeSessionMessage } from '../session-manager.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { getUserRoles } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { provisionPilotAtPress } from '../provision-handler.js';
import {
  tryActivatePilot,
  extractPilotCode,
  type ActivationContext,
  type ActivationHooks,
} from '../modules/pilot-activation/activation.js';
import {
  createActivation,
  consumeActivation,
  findActivePilotByUser,
  type PilotActivation,
  type PilotLang,
} from '../modules/pilot-activation/db.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

const CHANNEL_TYPE = 'telegram-joni';

/** Daniela — the supervisor agent group (shared with the pilot stack). */
const SUPERVISOR_AGENT_GROUP_ID = 'ag-1780401001748-zriukn';

/** Resolve the Johnny slug (agent-group folder) wired to a chat, or null. */
export function resolveJoniSlug(platformId: string): string | null {
  const mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
  if (!mg) return null;
  const agentGroupId = getMessagingGroupAgents(mg.id)[0]?.agent_group_id;
  if (!agentGroupId) return null;
  return getAgentGroup(agentGroupId)?.folder ?? null;
}

/** Copy one line of a Johnny conversation into Daniela's session (slug-tagged). */
export function mirrorToSupervisor(slug: string, who: 'user' | 'agent', text: string): void {
  try {
    const session = findSessionByAgentGroup(SUPERVISOR_AGENT_GROUP_ID);
    if (!session) {
      log.warn('Joni mirror: supervisor session not found', { slug, who });
      return;
    }
    writeSessionMessage(SUPERVISOR_AGENT_GROUP_ID, session.id, {
      id: `mirror-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        text: `[${slug}] ${who}: ${text}`,
        sender: 'joni-mirror',
        senderId: 'joni-mirror',
      }),
      trigger: 0,
    });
  } catch (err) {
    log.warn('Joni mirror failed', { err, slug, who });
  }
}

/** Extract the plain reply text from an outbound message for mirroring, or null. */
export function outboundMirrorText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown>;
  if (content.operation === 'edit' || content.operation === 'reaction') return null;
  if (content.type === 'ask_question' || content.type === 'card') return null;
  const raw = (content.markdown as string) || (content.text as string) || '';
  // Run the same outbound transform the bridge applies before sending, so the
  // supervisor mirror shows exactly what the user actually receives (no stray
  // long dashes / HR dividers in the mirror that the user never saw).
  const trimmed = sanitizeTelegramLegacyMarkdown(raw, { stripLongDashes: true }).trim();
  return trimmed ? trimmed : null;
}

function isGroupPlatformId(platformId: string): boolean {
  const chatId = platformId.split(':').slice(1).join(':');
  return chatId.startsWith('-');
}

function readInboundFields(message: InboundMessage): {
  text: string | null;
  authorUserId: string | null;
  senderName: string | null;
} {
  try {
    const parsed = (typeof message.content === 'string' ? JSON.parse(message.content) : message.content) as Record<
      string,
      unknown
    >;
    const text = typeof parsed.text === 'string' ? parsed.text : null;
    const senderId = typeof parsed.senderId === 'string' ? parsed.senderId : null;
    const authorUserId = senderId ? (senderId.includes(':') ? senderId.split(':').slice(1).join(':') : senderId) : null;
    const senderName =
      (typeof parsed.senderName === 'string' ? parsed.senderName : null) ??
      (typeof parsed.sender === 'string' ? parsed.sender : null);
    return { text, authorUserId, senderName };
  } catch {
    return { text: null, authorUserId: null, senderName: null };
  }
}

async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return data.ok ? (data.result?.username ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Send a plain text message to a Johnny chat. Checks the Telegram HTTP status
 * and retries on failure — a non-2xx (rate limit, transient error) used to be
 * swallowed silently, which could drop the opening greeting without a trace.
 */
async function sendJoniText(token: string, platformId: string, text: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  const DELAYS_MS = [0, 500, 1500];
  for (let attempt = 0; attempt < DELAYS_MS.length; attempt++) {
    if (DELAYS_MS[attempt]) await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      log.warn('Joni text send non-OK, retrying', {
        status: res.status,
        body: body.slice(0, 200),
        attempt: attempt + 1,
      });
    } catch (err) {
      log.warn('Joni text send failed, retrying', { err, attempt: attempt + 1 });
    }
  }
  log.error('Joni text send gave up after retries', { chatId });
}

/**
 * Johnny's opening line — message 1 of the approved v2 onboarding script
 * (Elia #16256). Fixed identity: he always introduces himself as ג'וני. The
 * agent (loaded with the full script) carries the conversation from here.
 */
async function sendJohnnyGreeting(token: string, platformId: string, lang: PilotLang): Promise<void> {
  const text =
    lang === 'en'
      ? `Hi, I'm Johnny, Elia developed me just for you. 👋\n\n` +
        `The world is already moving to work with personal AI agents, and I'm here so you can feel what that looks like and how it changes the way you work.\n\n` +
        `Want a quick tour, or shall we jump straight in? 🙂`
      : `היי, אני ג'וני. אליה פיתח אותי במיוחד בשבילך. 👋\n\n` +
        `העולם כבר עובר לעבוד עם סוכנים אישיים, ואני כאן כדי שתרגיש איך זה נראה ואיך זה משנה את העבודה.\n\n` +
        `רוצה שאקח אותך לסיבוב קצר, או שנתחיל ישר? 🙂`;
  await sendJoniText(token, platformId, text);
}

function wireMessagingGroupToAgentExclusive(mgId: string, agentGroupId: string): void {
  const existing = getMessagingGroupAgents(mgId);
  for (const w of existing) {
    if (w.agent_group_id !== agentGroupId) {
      deleteMessagingGroupAgent(w.id);
    }
  }
  if (getMessagingGroupAgentByPair(mgId, agentGroupId)) return;
  const now = new Date().toISOString();
  createMessagingGroupAgent({
    id: `mga-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
}

/**
 * Chat-side wiring for a Johnny chat: messaging group upsert, user upsert,
 * membership, and exclusive wiring to the given agent group. Idempotent.
 * Exported for reuse in WhatsApp provision.
 */
export function wireJoniChat(platformId: string, agentGroupId: string, userId: string, userName: string): void {
  const now = new Date().toISOString();
  let mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
  if (!mg) {
    const mgId = `mg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    createMessagingGroup({
      id: mgId,
      channel_type: CHANNEL_TYPE,
      platform_id: platformId,
      name: userName,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId)!;
  }
  upsertUser({ id: userId, kind: CHANNEL_TYPE, display_name: userName, created_at: now });
  wireMessagingGroupToAgentExclusive(mg.id, agentGroupId);
  const hasAccess = getUserRoles(userId).some((r) => r.agent_group_id === agentGroupId);
  if (!hasAccess) {
    addMember({ user_id: userId, agent_group_id: agentGroupId, added_by: null, added_at: now });
  }
}

/** Provision + wire + greet for one consumed activation. */
function buildActivationHooks(token: string): ActivationHooks {
  return {
    async activate(consumed: PilotActivation, ctx: ActivationContext): Promise<string> {
      const prov = provisionPilotAtPress({ activation: consumed, fallbackName: ctx.displayName });
      // Send the fixed greeting BEFORE wiring the chat to the agent. Wiring is
      // what lets the agent receive and answer messages; doing it last means a
      // message that arrives immediately after activation (the app handoff can
      // fire one within the provisioning window) can't reach the agent until
      // the greeting has gone out. This guarantees the greeting is the first
      // message on every new agent, deep-link (app) or bare /start alike.
      await sendJohnnyGreeting(token, ctx.platformId, prov.lang);
      wireJoniChat(ctx.platformId, prov.agentGroupId, ctx.userId, prov.userName);
      return prov.agentGroupId;
    },
    async alreadyActive(existing: PilotActivation, ctx: ActivationContext): Promise<void> {
      const agentGroupId = existing.agent_group_id!;
      const userName = ctx.displayName ?? 'User';
      wireJoniChat(ctx.platformId, agentGroupId, ctx.userId, userName);
      const lang: PilotLang = existing.lang === 'en' ? 'en' : 'he';
      await sendJoniText(
        token,
        ctx.platformId,
        lang === 'en'
          ? 'Your agent Johnny is already active here, just keep chatting 🙂'
          : "הסוכן שלך ג'וני כבר פעיל כאן, אפשר פשוט להמשיך לדבר איתו 🙂",
      );
    },
  };
}

/** True for a bare `/start` (Start button, no valid activation code payload). */
function isBareStart(text: string): boolean {
  const trimmed = text.trim();
  return /^\/start(\s|$)/i.test(trimmed) && extractPilotCode(text) === null;
}

/**
 * Bare `/start` with no deep-link code — mint an activation on the fly so a
 * walk-up user (opened the bot directly) still gets a Johnny agent bound to
 * their Telegram identity, with the "one active agent per user" guarantee.
 */
async function provisionBareStart(ctx: ActivationContext, hooks: ActivationHooks, token: string): Promise<void> {
  // Returning user with a live pilot → rewire to the existing agent, no dup.
  const existing = findActivePilotByUser(ctx.userId);
  if (existing?.agent_group_id) {
    await hooks.alreadyActive(existing, ctx);
    return;
  }
  const activation = createActivation({
    lang: 'he',
    metadata: { name: ctx.displayName ?? null, gender: 'm' },
  });
  const consumed = consumeActivation(activation.code, {
    userId: ctx.userId,
    agentGroupId: `pending-${Date.now()}`,
  });
  if (!consumed) {
    // Lost a race with a concurrent press — route to whatever now exists.
    const now = findActivePilotByUser(ctx.userId);
    if (now?.agent_group_id) await hooks.alreadyActive(now, ctx);
    return;
  }
  try {
    const agentGroupId = await hooks.activate(consumed, ctx);
    getDb()
      .prepare('UPDATE pilot_activations SET agent_group_id = ? WHERE code = ?')
      .run(agentGroupId, activation.code);
    log.info('Joni bare /start provisioned', { userId: ctx.userId, agentGroupId });
  } catch (err) {
    log.error('Joni bare /start provisioning failed', { userId: ctx.userId, err });
    await sendJoniText(token, ctx.platformId, 'משהו השתבש בהקמת הסוכן, נסה שוב בעוד דקה 🙂');
    // Re-open so a retry can succeed.
    getDb()
      .prepare(
        `UPDATE pilot_activations
         SET status = 'pending', used_by_user_id = NULL, used_at = NULL,
             agent_group_id = NULL, pilot_started_at = NULL, pilot_ends_at = NULL
         WHERE code = ?`,
      )
      .run(activation.code);
  }
}

function createJoniInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  const hooks = buildActivationHooks(token);
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId, senderName } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }

      const isGroup = isGroupPlatformId(platformId);
      const userId = authorUserId ? `${CHANNEL_TYPE}:${authorUserId}` : null;

      // 1. Deep-link activation (20-char code from the signup form) — fully
      //    consumed here when it matches, never reaches an agent.
      const activated = await tryActivatePilot({
        text,
        platformId,
        userId,
        displayName: senderName,
        isGroup,
        sendText: (t) => sendJoniText(token, platformId, t),
        hooks,
      });
      if (activated) return;

      // 2. Bare /start (no code) — every Start button press provisions Johnny.
      if (!isGroup && userId && isBareStart(text)) {
        await provisionBareStart({ platformId, userId, displayName: senderName }, hooks, token);
        return;
      }

      // 3. Established chat — mirror to the supervisor, then route to the agent.
      const slug = resolveJoniSlug(platformId);
      if (slug) mirrorToSupervisor(slug, 'user', text);
      hostOnInbound(platformId, threadId, message);
    } catch (err) {
      log.error('Joni interceptor error', { err });
      hostOnInbound(platformId, threadId, message);
    }
  };
}

function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const DELAYS = [1000, 3000, 10000, 30000, 60000];
  const attempt = async (i: number): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (i >= DELAYS.length) throw err;
      log.warn(`${label} failed, retrying`, { attempt: i + 1, delayMs: DELAYS[i], err });
      await new Promise((r) => setTimeout(r, DELAYS[i]));
      return attempt(i + 1);
    }
  };
  return attempt(0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile(['JONI_TELEGRAM_BOT_TOKEN']);
    const token = env['JONI_TELEGRAM_BOT_TOKEN'];
    if (!token) return null; // Disabled until token is set in .env

    const telegramAdapter = createTelegramAdapter({ botToken: token, mode: 'polling' });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      transformOutboundText: (t) => sanitizeTelegramLegacyMarkdown(t, { stripLongDashes: true }),
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      channelType: CHANNEL_TYPE,
      async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
        const result = await bridge.deliver(platformId, threadId, message);
        try {
          const text = outboundMirrorText(message);
          if (text) {
            const slug = resolveJoniSlug(platformId);
            if (slug) mirrorToSupervisor(slug, 'agent', text);
          }
        } catch (err) {
          log.warn('Joni outbound mirror failed', { err });
        }
        return result;
      },
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createJoniInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'joni-bridge.setup');
      },
    };

    log.info('Joni Telegram adapter initialized', { channelType: CHANNEL_TYPE });
    return wrapped;
  },
});
