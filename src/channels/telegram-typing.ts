/**
 * Telegram "typing…" indicator wrapper — parity with the WhatsApp Cloud
 * typing indicator (src/channels/whatsapp-cloud-pilot.ts).
 *
 * Telegram's sendChatAction shows the indicator for ~5s per call, so we
 * refresh every 4.5s from the moment an inbound text arrives until the
 * reply is delivered (deliver() clears the timer) or a 3-minute cap.
 *
 * Wrap the OUTERMOST adapter (after pairing/joni interceptors): the bridge
 * calls the interceptor first, so swallowed messages (activation codes,
 * pairing) never start a typing loop — only messages that actually route
 * to an agent do. Fire-and-forget: indicator failures never affect flow.
 */
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';

const REFRESH_MS = 4_500;
const MAX_MS = 180_000;

function hasText(message: InboundMessage): boolean {
  try {
    const parsed = (typeof message.content === 'string' ? JSON.parse(message.content) : message.content) as Record<
      string,
      unknown
    >;
    return typeof parsed.text === 'string' && parsed.text.length > 0;
  } catch {
    return false;
  }
}

export function wrapWithTelegramTyping(adapter: ChannelAdapter, botToken: string): ChannelAdapter {
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  const sendAction = (platformId: string): void => {
    const chatId = platformId.split(':').slice(1).join(':');
    if (!chatId) return;
    void fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => undefined);
  };

  const stop = (platformId: string): void => {
    const timer = timers.get(platformId);
    if (timer) {
      clearInterval(timer);
      timers.delete(platformId);
    }
  };

  const start = (platformId: string): void => {
    stop(platformId);
    sendAction(platformId);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > MAX_MS) {
        stop(platformId);
        return;
      }
      sendAction(platformId);
    }, REFRESH_MS);
    timers.set(platformId, timer);
  };

  return {
    ...adapter,

    async setup(hostConfig: ChannelSetup) {
      const wrappedOnInbound: ChannelSetup['onInbound'] = async (platformId, threadId, inbound) => {
        if (hasText(inbound)) start(platformId);
        return hostConfig.onInbound(platformId, threadId, inbound);
      };
      return adapter.setup({ ...hostConfig, onInbound: wrappedOnInbound });
    },

    async deliver(platformId, threadId, message) {
      stop(platformId);
      return adapter.deliver(platformId, threadId, message);
    },
  };
}
