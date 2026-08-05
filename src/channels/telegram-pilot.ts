/**
 * Telegram channel adapter for the dedicated NanoCo pilot bot.
 *
 * Mirrors the main telegram.ts adapter but:
 *  - Reads PILOT_TELEGRAM_BOT_TOKEN from .env (separate bot, no conflict with
 *    Daniela's bot @banielaclowbot).
 *  - Registers as channel type "telegram-pilot" so its messaging groups are
 *    namespaced away from the main Telegram channel.
 *  - Extended pairing interceptor: when intent.kind === "new-agent", wires
 *    the newly-paired chat to the pilot agent group and adds the user as a
 *    member. Without this the messages would land but never route to the
 *    agent.
 */
import crypto from 'crypto';

import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';

import { getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
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
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { getUserRoles } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { provisionPilotAtPress } from '../provision-handler.js';
import { tryActivatePilot, type ActivationContext } from '../modules/pilot-activation/activation.js';
import type { PilotActivation, PilotLang } from '../modules/pilot-activation/db.js';
import { tryConsume, extractCode } from './telegram-pairing.js';
import { registerChannelAdapter } from './channel-registry.js';
import { wrapWithTelegramTyping } from './telegram-typing.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

const CHANNEL_TYPE = 'telegram-pilot';

/**
 * Daniela — the supervisor agent group (same install / central DB as the
 * pilots). Every user message into a pilot chat and every agent reply out of
 * one is mirrored into her session, slug-tagged, so she can read all pilot
 * conversations from one place. Kept in sync with provision-handler.ts.
 */
const SUPERVISOR_AGENT_GROUP_ID = 'ag-1780401001748-zriukn';

/** Resolve the pilot slug (agent-group folder) wired to a pilot chat, or null. */
export function resolvePilotSlug(platformId: string): string | null {
  const mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
  if (!mg) return null;
  // Pilot chats are wired exclusively to a single pilot agent group.
  const agentGroupId = getMessagingGroupAgents(mg.id)[0]?.agent_group_id;
  if (!agentGroupId) return null;
  return getAgentGroup(agentGroupId)?.folder ?? null;
}

/**
 * Copy one line of pilot conversation into Daniela's session, prefixed with
 * the slug so separate pilots never blur together (e.g. "[pilot-867125] user:
 * …"). Written with trigger:0 — it accumulates as context Daniela reads next
 * time she's engaged, rather than waking her container on every pilot message.
 * Best-effort: a mirror failure must never affect the real message flow.
 */
export function mirrorToSupervisor(slug: string, who: 'user' | 'agent', text: string): void {
  try {
    const session = findSessionByAgentGroup(SUPERVISOR_AGENT_GROUP_ID);
    if (!session) {
      log.warn('Pilot mirror: supervisor session not found', { slug, who });
      return;
    }
    writeSessionMessage(SUPERVISOR_AGENT_GROUP_ID, session.id, {
      id: `mirror-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        text: `[${slug}] ${who}: ${text}`,
        sender: 'pilot-mirror',
        senderId: 'pilot-mirror',
      }),
      trigger: 0,
    });
  } catch (err) {
    log.warn('Pilot mirror failed', { err, slug, who });
  }
}

/** Extract the plain reply text from an outbound message for mirroring, or null. */
export function outboundMirrorText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown>;
  if (content.operation === 'edit' || content.operation === 'reaction') return null;
  if (content.type === 'ask_question' || content.type === 'card') return null;
  const raw = (content.markdown as string) || (content.text as string) || '';
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function isGroupPlatformId(platformId: string): boolean {
  // telegram group chats have negative IDs; DMs are positive.
  const chatId = platformId.split(':').slice(1).join(':');
  return chatId.startsWith('-');
}

function readInboundFields(message: InboundMessage): {
  text: string | null;
  authorUserId: string | null;
  senderName: string | null;
} {
  try {
    // content arrives as a plain object from chat-sdk-bridge (never stringified at this stage).
    const parsed = (typeof message.content === 'string' ? JSON.parse(message.content) : message.content) as Record<
      string,
      unknown
    >;
    const text = typeof parsed.text === 'string' ? parsed.text : null;
    const senderId = typeof parsed.senderId === 'string' ? parsed.senderId : null;
    // Strip platform prefix if present (e.g. "telegram:12345" → "12345").
    // If senderId has no colon (bare numeric ID from the Telegram adapter), use as-is.
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

/** Send a plain text message to a pilot chat (best-effort). */
async function sendPilotText(token: string, platformId: string, text: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    log.warn('Pilot text send failed', { err });
  }
}

async function sendPairingConfirmation(
  token: string,
  platformId: string,
  userName: string,
  lang: string,
): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const text =
      lang === 'en'
        ? `Hi ${userName}! 👋 I'm Jenny (ג'ני), your personal AI agent, just for you.\n\nSimple way to work together: we chat here, no setup, no technical language. Whatever you need, just ask, in your language, however is comfortable. When I need something to move forward, I'll tell you exactly what. And when you're not sure what's possible, ask me "can you X?" and I'll say if and how.\n\nOver time I'll also be able to connect to your systems — email, calendar and more — with a click, only when you want, always in your control.\n\nBut let's start from where you are: what's on your mind today? 🙂`
        : `אהלן ${userName}! 👋 אני ג'ני, סוכנת AI אישית, שלך בלבד.\n\nהדרך שלנו פשוטה: עובדים יחד בשיחה, כאן, בלי הגדרות ובלי שפה טכנית. מה שתצטרך, פשוט תבקש, בשפה שלך, איך שנוח לך. כשאני אצטרך משהו כדי להתקדם, אגיד לך בדיוק מה. וכשלא בטוח מה אפשר, תשאל אותי "את יכולה X?", ואני אגיד אם ואיך.\n\nעם הזמן אוכל גם להתחבר למערכות שלך, מייל, יומן ועוד, בלחיצה, רק כשתרצה, ותמיד בשליטה שלך.\n\nאבל בוא נתחיל מאיפה שאתה: מה על הראש שלך היום? משהו בעבודה, בבית, כל דבר, ונראה איך אני עוזרת. אני איתך. תרגיש חופשי. 🙂`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    log.warn('Pilot pairing confirmation failed', { err });
  }
}

function wireMessagingGroupToAgentExclusive(mgId: string, agentGroupId: string): void {
  // Remove all existing wirings for this messaging group so only the new agent responds.
  const existing = getMessagingGroupAgents(mgId);
  for (const w of existing) {
    if (w.agent_group_id !== agentGroupId) {
      deleteMessagingGroupAgent(w.id);
    }
  }
  if (getMessagingGroupAgentByPair(mgId, agentGroupId)) return; // already wired to this agent
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
 * Chat-side wiring for a pilot chat: messaging group upsert, user upsert,
 * membership, and exclusive wiring to the given agent group. Shared by the
 * activation-v2 path; idempotent, so re-activation is safe.
 */
function wirePilotChat(platformId: string, agentGroupId: string, userId: string, userName: string): void {
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

/**
 * Hooks handed to tryActivatePilot — provisioning + chat wiring + greeting
 * for the deep-link activation flow. Kept here (not in the module) so all
 * pilot-stack specifics (model, cost caps, supervisor, greeting copy) stay
 * in one place.
 */
function buildActivationHooks(token: string) {
  return {
    async activate(consumed: PilotActivation, ctx: ActivationContext): Promise<string> {
      const prov = provisionPilotAtPress({ activation: consumed, fallbackName: ctx.displayName });
      wirePilotChat(ctx.platformId, prov.agentGroupId, ctx.userId, prov.userName);
      await sendPairingConfirmation(token, ctx.platformId, prov.userName, prov.lang);
      return prov.agentGroupId;
    },
    async alreadyActive(existing: PilotActivation, ctx: ActivationContext): Promise<void> {
      const agentGroupId = existing.agent_group_id!;
      const userName = ctx.displayName ?? 'User';
      // Idempotent — points this chat at the user's existing agent (covers
      // the same user activating again from a fresh chat after clearing
      // history) without ever creating a duplicate.
      wirePilotChat(ctx.platformId, agentGroupId, ctx.userId, userName);
      const lang: PilotLang = existing.lang === 'en' ? 'en' : 'he';
      await sendPilotText(
        token,
        ctx.platformId,
        lang === 'en'
          ? "Your agent ג'ני is already active here — just keep chatting 🙂"
          : "הסוכנת שלך ג'ני כבר פעילה כאן — אפשר פשוט להמשיך לדבר איתה 🙂",
      );
    },
  };
}

function createPilotPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
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

      // Activation v2 (deep-link 20-char codes) — checked before the legacy
      // 4-digit pairing path; the two code formats are disjoint. Handled
      // attempts are fully consumed here and never reach an agent.
      const activated = await tryActivatePilot({
        text,
        platformId,
        userId: authorUserId ? `${CHANNEL_TYPE}:${authorUserId}` : null,
        displayName: senderName,
        isGroup: isGroupPlatformId(platformId),
        sendText: (t) => sendPilotText(token, platformId, t),
        hooks: buildActivationHooks(token),
      });
      if (activated) return;

      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
        name: senderName,
      });
      if (!consumed) {
        const slug = resolvePilotSlug(platformId);
        // A code-shaped message on a chat NOT yet wired to a pilot means the
        // code failed to pair (expired past its 15-min TTL, wrong, or already
        // used). Reply gracefully instead of dropping it silently. On an
        // already-wired chat a 4-digit message is real content → routes below.
        if (!slug && extractCode(text, botUsername) !== null) {
          await sendPilotText(
            token,
            platformId,
            'הקוד לא תקף או שפג תוקפו (קוד תקף ל-15 דקות). חזור לדף ההרשמה ובקש קוד חדש כדי להתחיל 🙂',
          );
          return;
        }
        // Established (non-pairing) message in a pilot chat — mirror the user's
        // text up to Daniela, then route to the pilot agent as usual.
        if (slug) mirrorToSupervisor(slug, 'user', text);
        hostOnInbound(platformId, threadId, message);
        return;
      }

      const now = new Date().toISOString();
      const intent = consumed.intent;
      // Prefer the registered name from the provisioning form; fall back to the Telegram profile name.
      const registeredName = intent !== 'main' && intent.kind === 'new-agent' ? intent.userName?.trim() || '' : '';
      const userName = registeredName || consumed.consumed!.name || 'User';

      // 1. Upsert messaging group
      let mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
      if (mg) {
        updateMessagingGroup(mg.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
        mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId)!;
      } else {
        const mgId = `mg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        createMessagingGroup({
          id: mgId,
          channel_type: CHANNEL_TYPE,
          platform_id: platformId,
          name: userName,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: now,
        });
        mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId)!;
      }

      // 2. Upsert user
      const pairedUserId = `${CHANNEL_TYPE}:${consumed.consumed!.adminUserId}`;
      upsertUser({ id: pairedUserId, kind: CHANNEL_TYPE, display_name: userName, created_at: now });

      // 3. NO owner promotion in the hosted pilot path. This is a shared,
      //    multi-user bot: granting the first paired user a global owner role
      //    (agent_group_id: null) would hand them control over every agent on
      //    the install. Pilot users get access to their own agent group only,
      //    via addMember below (step 4). The main-channel owner bootstrap
      //    (telegram.ts) is unaffected.

      // 4. Wire to agent if this was a new-agent provisioning intent
      if (intent !== 'main' && intent.kind === 'new-agent' && intent.folder) {
        const agentGroup = getAgentGroupByFolder(intent.folder);
        if (agentGroup && mg) {
          wireMessagingGroupToAgentExclusive(mg.id, agentGroup.id);

          // Add the user as a member of this agent group
          const existingRoles = getUserRoles(pairedUserId);
          const hasAccess = existingRoles.some((r) => r.agent_group_id === agentGroup.id);
          if (!hasAccess) {
            addMember({ user_id: pairedUserId, agent_group_id: agentGroup.id, added_by: null, added_at: now });
          }

          log.info('Pilot pairing: wired chat to agent', {
            platformId,
            folder: intent.folder,
            agentGroupId: agentGroup.id,
            mgId: mg.id,
            user: pairedUserId,
          });
        } else {
          log.warn('Pilot pairing: agent group not found for intent', { folder: intent.folder });
        }
      }

      const greetingLang = intent !== 'main' && intent.kind === 'new-agent' ? (intent.lang ?? 'he') : 'he';
      log.info('Pilot Telegram pairing accepted', { platformId, user: pairedUserId, intent });
      await sendPairingConfirmation(token, platformId, userName, greetingLang);
    } catch (err) {
      log.error('Pilot pairing interceptor error', { err });
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
    const env = readEnvFile(['PILOT_TELEGRAM_BOT_TOKEN']);
    const token = env['PILOT_TELEGRAM_BOT_TOKEN'];
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
        // Mirror the agent's outgoing reply up to Daniela (slug-tagged).
        try {
          const text = outboundMirrorText(message);
          if (text) {
            const slug = resolvePilotSlug(platformId);
            if (slug) mirrorToSupervisor(slug, 'agent', text);
          }
        } catch (err) {
          log.warn('Pilot outbound mirror failed', { err });
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
          onInbound: createPilotPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'pilot-bridge.setup');
      },
    };

    log.info('Pilot Telegram adapter initialized', { channelType: CHANNEL_TYPE });
    return wrapWithTelegramTyping(wrapped, token);
  },
});
