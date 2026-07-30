/**
 * WhatsApp Cloud API channel adapter (v2) — uses Chat SDK bridge.
 * Uses the official Meta WhatsApp Business Cloud API (not Baileys).
 * Self-registers on import.
 *
 * NOTE: this install's ChannelAdapter/ChannelRegistration/ChatSdkBridgeConfig
 * do not carry the `defaults` (wiring-defaults) field from the `channels`
 * branch — same as the native Baileys adapter (src/channels/whatsapp.ts).
 * The intended defaults are kept below as documentation only; they are not
 * wired into the bridge/registration, matching the native adapter.
 */
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('whatsapp-cloud', {
  factory: () => {
    const env = readEnvFile([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_VERIFY_TOKEN',
    ]);
    if (!env.WHATSAPP_ACCESS_TOKEN) return null;
    const whatsappAdapter = createWhatsAppAdapter({
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      appSecret: env.WHATSAPP_APP_SECRET,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    });
    // `@chat-adapter/whatsapp` hardcodes name = 'whatsapp', which the bridge
    // uses as channelType. Without a distinct instance the registry would key
    // this bridge under 'whatsapp' and collide with the native Baileys adapter
    // (src/channels/whatsapp.ts, also channelType 'whatsapp') — last-write-wins
    // silently kills one channel. The instance key keeps them apart while
    // channelType stays 'whatsapp' (the semantic platform key). See #2911.
    return createChatSdkBridge({
      adapter: whatsappAdapter,
      instance: 'whatsapp-cloud',
      concurrency: 'concurrent',
      supportsThreads: false,
    });
  },
});
