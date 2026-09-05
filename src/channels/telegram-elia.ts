/**
 * Telegram adapter for Elia's personal bot, migrated from the standalone
 * Shellanoo host into this unified install (2026-08-31 cutover).
 *
 * Registers as the isolated instance "telegram-elia" so it never collides
 * with Daniela's main "telegram" bot (879542…) — one instance polls one
 * token, so the two bots coexist as separate adapters. Reads
 * ELIA_TELEGRAM_BOT_TOKEN from .env.
 *
 * The chat (platform_id telegram:8785317775) is pre-wired to the Daniela
 * agent group in the DB, so no pairing / owner-bootstrap is needed here —
 * inbound just routes through the host's default onInbound.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { wrapWithTelegramTyping } from './telegram-typing.js';
import type { ChannelAdapter } from './adapter.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

const CHANNEL_TYPE = 'telegram-elia';

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
    const env = readEnvFile(['ELIA_TELEGRAM_BOT_TOKEN']);
    const token = env['ELIA_TELEGRAM_BOT_TOKEN'];
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
    };

    log.info('Elia Telegram adapter initialized', { channelType: CHANNEL_TYPE });
    return wrapWithTelegramTyping(wrapped, token);
  },
});
