/**
 * Pilot provisioning + supervisor mirroring for the WhatsApp Cloud API
 * channel — port of the pilot block from the native Baileys adapter
 * (src/channels/whatsapp.ts ~L1025-1165, now credential-less/dead).
 *
 * Wraps the Chat SDK bridge returned by whatsapp-cloud.ts:
 *  - inbound: first DM to an unwired chat → activation-code consume OR
 *    walk-up provision (Johnny), returning sender rewired, code messages
 *    swallowed; every pilot user line mirrored to Daniela.
 *  - outbound: every pilot agent reply mirrored to Daniela.
 *
 * Platform id format differs from Baileys: the bridge encodes chats as
 * "whatsapp:<phoneNumberId>:<userNumber>" (not "<num>@s.whatsapp.net").
 * userId stays "whatsapp:<userNumber>" — same namespace as Baileys, so a
 * user who piloted on the old number is recognized as returning.
 *
 * Messaging groups must carry instance='whatsapp-cloud' or delivery can't
 * resolve the adapter (registry is keyed by instance; wireJoniChat defaults
 * instance to the channel type). We stamp it after wiring.
 */
import { getAgentGroup } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { detectLang, findPilotCodeInText } from '../modules/pilot-activation/activation.js';
import { consumeActivation, createActivation, findActivePilotByUser } from '../modules/pilot-activation/db.js';
import { getLatestMembershipByUser } from '../modules/permissions/db/agent-group-members.js';
import { provisionPilotAtPress } from '../provision-handler.js';
import { mirrorToSupervisor, outboundMirrorText, wireJoniChat } from './telegram-joni.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const INSTANCE = 'whatsapp-cloud';
const CHANNEL_TYPE = 'whatsapp';

/** "whatsapp:<phoneNumberId>:<userNumber>" → "<userNumber>", or null. */
function senderNumberFromPlatformId(platformId: string): string | null {
  const parts = platformId.split(':');
  const num = parts[parts.length - 1];
  return /^\d{6,}$/.test(num) ? num : null;
}

/** Pilot slug (agent-group folder) wired to this chat, or null. */
function resolvePilotSlug(platformId: string): string | null {
  const mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
  if (!mg) return null;
  const agentGroupId = getMessagingGroupAgents(mg.id)[0]?.agent_group_id;
  if (!agentGroupId) return null;
  const folder = getAgentGroup(agentGroupId)?.folder ?? null;
  return folder && (folder.startsWith('whatsapp-') || folder.startsWith('pilot-')) ? folder : null;
}

/**
 * Attribution from a code-less landing pre-fill. The landing composes
 * "היי, קוראים לי <שם>, אשמח לפתוח סוכן אישי. (<source>)" — the trailing
 * parenthesized token is the per-link source tag Daniela mints for funnel
 * measurement, and the name follows a small set of Hebrew/English openers.
 * Both are optional: a bare walk-up text yields nulls and the dashboard
 * shows what it actually knows.
 */
export function parseWalkupAttribution(text: string): { name: string | null; src: string | null } {
  const srcMatch = text.trim().match(/\(([\w][\w.-]{1,40})\)\s*$/);
  const src = srcMatch ? srcMatch[1] : null;
  const body = srcMatch ? text.trim().slice(0, -srcMatch[0].length) : text;
  const nameMatch = body.match(/(?:קוראים לי|שמי|my name is|i'?m)\s+([^,.\n()]{2,40})/i);
  const name = nameMatch ? nameMatch[1].trim() : null;
  return { name, src };
}

function readInbound(message: InboundMessage): {
  text: string | null;
  senderName: string | null;
  isGroup: boolean;
} {
  try {
    const parsed = (typeof message.content === 'string' ? JSON.parse(message.content) : message.content) as Record<
      string,
      unknown
    >;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : null,
      senderName:
        (typeof parsed.senderName === 'string' ? parsed.senderName : null) ??
        (typeof parsed.sender === 'string' ? parsed.sender : null),
      isGroup: message.isGroup === true,
    };
  } catch {
    return { text: null, senderName: null, isGroup: message.isGroup === true };
  }
}

/**
 * Typing indicator — mark the inbound message as read and show "typing…"
 * while the agent thinks. WhatsApp shows the indicator for ~25s per call,
 * so we refresh every 20s until the reply goes out (deliver() clears the
 * timer) or a 3-minute cap, whichever comes first. Fire-and-forget: a
 * failed indicator call must never affect message flow.
 */
const TYPING_REFRESH_MS = 20_000;
const TYPING_MAX_MS = 180_000;
const typingTimers = new Map<string, ReturnType<typeof setInterval>>();

function sendTypingIndicator(inboundMessageId: string): void {
  const env = readEnvFile(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return;
  void fetch(`https://graph.facebook.com/v25.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: inboundMessageId,
      typing_indicator: { type: 'text' },
    }),
  }).catch(() => undefined);
}

function startTyping(platformId: string, inboundMessageId: string): void {
  stopTyping(platformId);
  sendTypingIndicator(inboundMessageId);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - startedAt > TYPING_MAX_MS) {
      stopTyping(platformId);
      return;
    }
    sendTypingIndicator(inboundMessageId);
  }, TYPING_REFRESH_MS);
  typingTimers.set(platformId, timer);
}

function stopTyping(platformId: string): void {
  const timer = typingTimers.get(platformId);
  if (timer) {
    clearInterval(timer);
    typingTimers.delete(platformId);
  }
}

/**
 * Real document delivery — `@chat-adapter/whatsapp`'s postMessage silently
 * DROPS `files` (text-only), so agents were told "sent" while the user got
 * nothing. We upload each file to the Cloud API media endpoint and send a
 * `document` message ourselves. Throwing on failure is load-bearing: a
 * dropped file must surface as a delivery error, never a fake success.
 */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  zip: 'application/zip',
  json: 'application/json',
  md: 'text/plain',
};

function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

async function sendDocumentViaCloudApi(toNumber: string, file: { filename: string; data: Buffer }): Promise<void> {
  const env = readEnvFile(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WhatsApp Cloud credentials missing for media send');

  const mime = mimeFor(file.filename);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([file.data], { type: mime }), file.filename);
  const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const upload = (await uploadRes.json()) as { id?: string; error?: { message?: string } };
  if (!uploadRes.ok || !upload.id) {
    throw new Error(`WhatsApp media upload failed for ${file.filename}: ${upload.error?.message ?? uploadRes.status}`);
  }

  const isImage = mime.startsWith('image/');
  const sendRes = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toNumber,
      type: isImage ? 'image' : 'document',
      ...(isImage ? { image: { id: upload.id } } : { document: { id: upload.id, filename: file.filename } }),
    }),
  });
  const sent = (await sendRes.json()) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!sendRes.ok || !sent.messages?.length) {
    throw new Error(`WhatsApp document send failed for ${file.filename}: ${sent.error?.message ?? sendRes.status}`);
  }
}

/** Delivery resolves adapters by mg.instance — make sure ours is stamped. */
function stampInstance(platformId: string): void {
  getDb()
    .prepare('UPDATE messaging_groups SET instance = ? WHERE channel_type = ? AND platform_id = ?')
    .run(INSTANCE, CHANNEL_TYPE, platformId);
}

export function wrapWithPilotProvisioning(bridge: ChannelAdapter): ChannelAdapter {
  const sendText = async (platformId: string, text: string): Promise<void> => {
    stopTyping(platformId); // greetings/errors bypass the wrapper's deliver()
    await bridge.deliver(platformId, null, {
      id: `pilot-${Date.now()}`,
      content: { text },
    } as unknown as OutboundMessage);
  };

  return {
    ...bridge,

    async setup(hostConfig: ChannelSetup) {
      const originalOnInbound = hostConfig.onInbound;

      const wrappedOnInbound: ChannelSetup['onInbound'] = async (platformId, threadId, inbound) => {
        try {
          const { text, senderName, isGroup } = readInbound(inbound);
          const sender = senderNumberFromPlatformId(platformId);

          // Read receipt + "typing…" while the agent works (refreshed until
          // the reply is delivered). inbound.id is the WhatsApp wamid.
          if (!isGroup && text && inbound.id) startTyping(platformId, inbound.id);

          if (text) {
            const slug = resolvePilotSlug(platformId);
            if (slug) mirrorToSupervisor(slug, 'user', text);
          }

          // First-message provisioning — identical decision tree to the
          // Baileys adapter. Only fires for a DM whose chat isn't wired yet.
          if (!isGroup && sender && text) {
            const existingMg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
            const isWired = existingMg ? getMessagingGroupAgents(existingMg.id).length > 0 : false;

            if (!existingMg || !isWired) {
              const activationCode = findPilotCodeInText(text);
              const userId = `whatsapp:${sender}`;
              // One agent per sender: returning users are rewired, never
              // re-provisioned. Two lookups — see whatsapp.ts rationale.
              const existingAgentId = (() => {
                const active = findActivePilotByUser(userId);
                if (
                  active?.agent_group_id &&
                  !active.agent_group_id.startsWith('pending-') &&
                  getAgentGroup(active.agent_group_id)
                ) {
                  return active.agent_group_id;
                }
                const member = getLatestMembershipByUser(userId);
                return member && getAgentGroup(member.agent_group_id) ? member.agent_group_id : null;
              })();

              try {
                if (existingAgentId) {
                  wireJoniChat(platformId, existingAgentId, userId, senderName || 'User', CHANNEL_TYPE);
                  stampInstance(platformId);
                  log.info('WhatsApp Cloud returning sender rewired to existing agent', {
                    userId,
                    agentGroupId: existingAgentId,
                  });
                  if (activationCode) {
                    await sendText(
                      platformId,
                      detectLang(text) === 'en'
                        ? "You're already set up — picking up right where we left off. 🙂"
                        : 'הכל כבר מוכן — ממשיכים מאיפה שהפסקנו. 🙂',
                    );
                    return; // swallow the code message
                  }
                  // Walk-up text falls through to the existing agent.
                } else if (activationCode) {
                  // Deep-link flow: consume the code, provision, greet,
                  // swallow — the raw code never reaches the agent.
                  const consumed = consumeActivation(activationCode, {
                    userId,
                    agentGroupId: `pending-${Date.now()}`,
                  });
                  if (!consumed) {
                    log.warn('WhatsApp Cloud activation code invalid or expired', { code: activationCode });
                    await sendText(
                      platformId,
                      detectLang(text) === 'en'
                        ? "This code isn't valid or was already used. You can request a new link from the signup form. 🙂"
                        : 'הקוד הזה לא תקף או שכבר נוצל. אפשר לבקש קישור חדש בטופס ההרשמה. 🙂',
                    );
                    return; // no agent for a bad code
                  }
                  const prov = provisionPilotAtPress({
                    activation: consumed,
                    fallbackName: senderName || null,
                    channel: 'WhatsApp',
                  });
                  // Greeting BEFORE wiring — guarantees it's the first
                  // message on every new agent (Telegram parity). Mirrors the
                  // master template's own opening line (pilot_agent_script_v2.md,
                  // "הפתיחה והזרימה") — short, no "world is moving to agents"
                  // pitch, straight to a scenario-forcing question. Replaces the
                  // old 3-part pitch per pending_after_wa_e2e.md item 1 (Elia,
                  // 2026-08-03 #63062), implemented once WA Cloud E2E was verified.
                  const greetName = prov.userName !== 'User' ? prov.userName : null;
                  await sendText(
                    platformId,
                    prov.lang === 'en'
                      ? `Hi${greetName ? ` ${greetName}` : ''}, I'm Johnny. Elia developed me just for you. 👋 What's on your mind today — anything we can work on together?`
                      : `היי${greetName ? ` ${greetName}` : ''}, אני ג'וני. אליה פיתח אותי במיוחד בשבילך. 👋 מה הכי מעסיק אותך היום, יש משהו שנעבוד עליו יחד?`,
                  );
                  wireJoniChat(platformId, prov.agentGroupId, userId, senderName || prov.userName, CHANNEL_TYPE);
                  stampInstance(platformId);
                  getDb()
                    .prepare('UPDATE pilot_activations SET agent_group_id = ? WHERE code = ?')
                    .run(prov.agentGroupId, activationCode);
                  log.info('WhatsApp Cloud pilot provisioned via activation code', {
                    slug: prov.slug,
                    agentGroupId: prov.agentGroupId,
                    userId,
                  });
                  return; // code message consumed
                } else {
                  // Walk-up flow: first message with no code. Mint + consume a
                  // real activation row (not a synthetic one) so the dashboard
                  // gets name/source attribution — the landing's code-less
                  // pre-fill carries both in the text itself.
                  const attr = parseWalkupAttribution(text);
                  const minted = createActivation({
                    lang: detectLang(text),
                    metadata: {
                      name: attr.name || senderName || null,
                      gender: 'm',
                      ...(attr.src ? { src: attr.src } : {}),
                    },
                  });
                  const consumed = consumeActivation(minted.code, {
                    userId,
                    agentGroupId: `pending-${Date.now()}`,
                  });
                  if (!consumed) throw new Error('walk-up activation consume failed');
                  const prov = provisionPilotAtPress({
                    activation: consumed,
                    fallbackName: attr.name || senderName || null,
                    channel: 'WhatsApp',
                  });
                  wireJoniChat(platformId, prov.agentGroupId, userId, senderName || prov.userName, CHANNEL_TYPE);
                  stampInstance(platformId);
                  getDb()
                    .prepare('UPDATE pilot_activations SET agent_group_id = ? WHERE code = ?')
                    .run(prov.agentGroupId, minted.code);
                  log.info('WhatsApp Cloud pilot provisioned for walk-up sender', {
                    slug: prov.slug,
                    agentGroupId: prov.agentGroupId,
                    userId,
                    source: attr.src,
                  });
                }
              } catch (err) {
                log.error('WhatsApp Cloud pilot provisioning failed', { err, sender, senderName });
              }
            }
          }
        } catch (err) {
          log.error('WhatsApp Cloud pilot interceptor error', { err, platformId });
        }

        return originalOnInbound(platformId, threadId, inbound);
      };

      return bridge.setup({ ...hostConfig, onInbound: wrappedOnInbound });
    },

    async deliver(platformId, threadId, message) {
      stopTyping(platformId);
      // Send attachments FIRST and let failures throw — if a document can't
      // go out, the whole delivery must fail loudly (agent retries / errors)
      // rather than the text landing with a phantom "sent you the file".
      const files = message.files;
      if (files && files.length > 0) {
        const toNumber = senderNumberFromPlatformId(platformId);
        if (!toNumber) throw new Error(`Cannot resolve recipient number from ${platformId}`);
        for (const file of files) {
          await sendDocumentViaCloudApi(toNumber, file);
          log.info('WhatsApp Cloud document sent', { platformId, filename: file.filename });
        }
        // Files delivered; if there's no accompanying text the bridge would
        // try to post an empty message — skip it.
        const c = message.content as Record<string, unknown>;
        if (!c.text && !c.markdown) return undefined;
      }
      const result = await bridge.deliver(platformId, threadId, message);
      try {
        const slug = resolvePilotSlug(platformId);
        if (slug) {
          const mirrored = outboundMirrorText(message);
          if (mirrored) mirrorToSupervisor(slug, 'agent', mirrored);
        }
      } catch (err) {
        log.warn('WhatsApp Cloud outbound mirror failed', { err, platformId });
      }
      return result;
    },
  };
}
