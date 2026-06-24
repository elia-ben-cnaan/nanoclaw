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

import { getAgentGroupByFolder } from '../db/agent-groups.js';
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
import { grantRole, getUserRoles } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { tryConsume } from './telegram-pairing.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

const CHANNEL_TYPE = 'telegram-pilot';

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
        ? `Hi ${userName}! 👋 I'm your Nano, a personal AI agent, just for you.\n\nSimple way to work together: we chat here, no setup, no technical language. Whatever you need, just ask, in your language, however is comfortable. When I need something to move forward, I'll tell you exactly what. And when you're not sure what's possible, ask me "can you X?" and I'll say if and how.\n\nOver time I'll also be able to connect to your systems — email, calendar and more — with a click, only when you want, always in your control.\n\nBut let's start from where you are: what's on your mind today? 🙂\n(And by the way, you can call me whatever you like. Just say so.)`
        : `אהלן ${userName}! 👋 אני הננו שלך, סוכן AI אישי, שלך בלבד.\n\nהדרך שלנו פשוטה: עובדים יחד בשיחה, כאן, בלי הגדרות ובלי שפה טכנית. מה שתצטרך, פשוט תבקש, בשפה שלך, איך שנוח לך. כשאני אצטרך משהו כדי להתקדם, אגיד לך בדיוק מה. וכשלא בטוח מה אפשר, תשאל אותי "אתה יכול X?", ואני אגיד אם ואיך.\n\nעם הזמן אוכל גם להתחבר למערכות שלך, מייל, יומן ועוד, בלחיצה, רק כשתרצה, ותמיד בשליטה שלך.\n\nאבל בוא נתחיל מאיפה שאתה: מה על הראש שלך היום? משהו בעבודה, בבית, כל דבר, ונראה איך אני עוזר. אני איתך. תרגיש חופשי. 🙂\n\n(ואגב, אפשר לקרוא לי איך שתרצה. רק תגיד.)`;
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
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
        name: senderName,
      });
      if (!consumed) {
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

      // 3. Grant owner role if none exists yet
      if (!hasAnyOwner()) {
        grantRole({ user_id: pairedUserId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
      }

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
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token);

    const wrapped: ChannelAdapter = {
      ...bridge,
      channelType: CHANNEL_TYPE,
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
    return wrapped;
  },
});
