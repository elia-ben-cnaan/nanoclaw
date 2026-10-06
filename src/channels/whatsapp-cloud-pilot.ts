import { whatsappInboundBlockReason } from '../whatsapp-loop-guard.js';
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
import {
  detectLang,
  findPilotCodeInText,
  walkupDefaultSrc,
  walkupLang,
} from '../modules/pilot-activation/activation.js';
import { consumeActivation, createActivation, findActivePilotByUser } from '../modules/pilot-activation/db.js';
import {
  bindConsentNonce,
  findConsentNonceInText,
  hasConsentRecordForUser,
  walkupConsentGateEnabled,
} from '../modules/pilot-activation/consent-nonce.js';
import { getLatestMembershipByUser } from '../modules/permissions/db/agent-group-members.js';
import { provisionPilotAtPress } from '../provision-handler.js';
import { mirrorToSupervisor, outboundMirrorText, wireJoniChat } from './telegram-joni.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { spokenText, synthesizeSpeech, voiceRepliesEnabled } from './voice-replies.js';

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
/**
 * Natural-language origin phrases → campaign src slugs. The landing's
 * campaign pages (click2agent vercel.json redirects: /avigail/linkedin,
 * /linkers, /elia/linkedin, /learning) append one of these phrases to the
 * pre-filled first message instead of a machine-looking "(tag)" — per Elia's
 * 30.7 decision the message must read like the user wrote it. Keep in sync
 * with SRC_PHRASES in the landing's whatsapp.html. Anchored on the full
 * "הגעתי דרך… / I got here through…" wording so a campaign name mentioned
 * casually mid-conversation can't false-attribute a signup.
 */
const SRC_PHRASES: Array<[RegExp, string]> = [
  [/הגעתי דרך שירות חיפוש העבודה|got here through the job search service/i, 'agent4job'],
  [/הגעתי דרך אביגיל|got here through Avigail/i, 'avigail-linkedin-1'],
  [/הגעתי דרך קהילת Linkers|got here through the Linkers community/i, 'linkers-1'],
  [/הגעתי דרך הפוסט של אליה|got here through Elia'?s LinkedIn post/i, 'elia-linkedin-1'],
  [/הגעתי דרך קהילת הלמידה|got here through the learning community/i, 'learning-1'],
];

export function parseWalkupAttribution(text: string): { name: string | null; src: string | null } {
  const trimmed = text.trim();
  // Preferred: tag at the very end (the landing's canonical placement).
  let srcMatch = trimmed.match(/\(([\w][\w.-]{1,40})\)\s*$/);
  if (!srcMatch) {
    // Tolerant fallback (2026-08-05): users edit the pre-fill — a period,
    // emoji, or an extra sentence after the tag used to drop the whole
    // attribution to "לא ידוע" on the panel. Accept a latin campaign-style
    // token anywhere in the text (last occurrence wins — campaign tags are
    // latin/hyphen slugs like avigail-linkedin-1, so a Hebrew sentence's own
    // parentheses can't false-match).
    const all = [...trimmed.matchAll(/\(([A-Za-z][A-Za-z0-9._-]{1,40})\)/g)];
    if (all.length > 0) srcMatch = all[all.length - 1];
  }
  let src = srcMatch ? srcMatch[1] : null;
  if (!src) {
    // Natural-phrase attribution — the campaign pages' human-sounding origin
    // sentence ("הגעתי דרך אביגיל") maps back to its slug.
    for (const [re, slug] of SRC_PHRASES) {
      if (re.test(trimmed)) {
        src = slug;
        break;
      }
    }
  }
  const body = srcMatch ? trimmed.replace(srcMatch[0], ' ') : text;
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

async function sendVoiceViaCloudApi(toNumber: string, audio: Buffer): Promise<void> {
  const env = readEnvFile(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WhatsApp Cloud credentials missing for voice send');

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/mpeg');
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'agent-reply.mp3');
  const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const upload = (await uploadRes.json()) as { id?: string; error?: { message?: string } };
  if (!uploadRes.ok || !upload.id)
    throw new Error(`WhatsApp voice upload failed: ${upload.error?.message ?? uploadRes.status}`);

  const sendRes = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toNumber,
      type: 'audio',
      audio: { id: upload.id },
    }),
  });
  if (!sendRes.ok) throw new Error(`WhatsApp voice send failed (${sendRes.status})`);
}

/**
 * Walk-up consent binding (Shellanoo spec, 2026-10-06) — user-facing copy.
 * Every reply here ends the turn WITHOUT provisioning; nothing reaches an
 * agent. Language follows the message (walkupLang: Hebrew unless clearly
 * English).
 */
const CONSENT_FEEDBACK = {
  phoneMismatch: {
    he: 'הקישור הזה כבר שימש מספר אחר. כדי להתחיל, פתח/י את הקישור מחדש מדף ההרשמה ממכשיר זה. 🙂',
    en: 'This link was already used from another number. To start, open the link again from the signup page on this device. 🙂',
  },
  expired: {
    he: 'הקישור הזה פג תוקף (קישורים תקפים ל-24 שעות). אפשר לפתוח קישור חדש מדף ההרשמה. 🙂',
    en: 'This link has expired (links are valid for 24 hours). Open a new one from the signup page. 🙂',
  },
  needsConsent: {
    he: 'כדי שאוכל להתחיל צריך קודם לאשר את מדיניות הפרטיות בדף ההרשמה ולפתוח את השיחה משם. 🙂',
    en: 'Before we start, please accept the privacy policy on the signup page and open the chat from there. 🙂',
  },
  storageFailure: {
    he: 'משהו השתבש אצלנו לרגע. נסה/י לשלוח את ההודעה שוב בעוד דקה.',
    en: 'Something went wrong on our side for a moment. Please send the message again in a minute.',
  },
} as const;

function consentFeedback(key: keyof typeof CONSENT_FEEDBACK, text: string): string {
  const landing = (process.env.WALKUP_CONSENT_LANDING_URL ?? '').trim();
  const base = CONSENT_FEEDBACK[key][walkupLang(text)];
  return landing && (key === 'needsConsent' || key === 'expired' || key === 'phoneMismatch') ? `${base}\n${landing}` : base;
}

/** Delivery resolves adapters by mg.instance — make sure ours is stamped. */
function stampInstance(platformId: string): void {
  getDb()
    .prepare('UPDATE messaging_groups SET instance = ? WHERE channel_type = ? AND platform_id = ?')
    .run(INSTANCE, CHANNEL_TYPE, platformId);
}

/**
 * Native WhatsApp URL button (isolated add-on, 2026-08-31).
 * The `@chat-adapter/whatsapp` SDK (v4.29.0) has no `cta_url` support, so a
 * card whose only action is an https link flattens to plain text. We detect
 * that exact shape and send a native interactive `cta_url` via the Cloud API.
 * Any other shape (no card / >1 action / missing or non-https url) returns
 * null and delivery falls through to the existing path unchanged.
 */
interface CtaUrlSpec {
  body: string;
  header: string | null;
  displayText: string;
  url: string;
}

function actionEmojiForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const kind = parsed.searchParams.get('t')?.toLowerCase();
    if (kind === 'email') return '📧';
    if (kind === 'outlook') return '📨';
    if (kind === 'wa' || kind === 'whatsapp') return '🟢';
    if (kind === 'cal' || kind === 'calendar') return '📅';
    if (kind === 'teams' || kind === 'sms') return '💬';
    if (kind === 'meet' || kind === 'video') return '🎥';
    if (kind === 'phone' || kind === 'call') return '📞';
    if (kind === 'drive' || kind === 'navigate') return '🚗';
    if (kind === 'maps' || kind === 'trip' || kind === 'plan' || kind === 'schedule') return '⏰';
    if (parsed.hostname === 'wa.me' || parsed.hostname.endsWith('.whatsapp.com')) return '🟢';
    if (parsed.hostname.includes('calendar.google')) return '📅';
    if (parsed.hostname === 'meet.google.com' || parsed.hostname.endsWith('.zoom.us')) return '🎥';
    if (parsed.hostname === 'waze.com' || parsed.hostname.endsWith('.waze.com')) {
      return parsed.searchParams.get('navigate') === 'yes' ? '🚗' : '⏰';
    }
    if (parsed.hostname.includes('maps.google')) return parsed.pathname.includes('/dir/') ? '🚗' : '⏰';
  } catch {
    // The caller validates the URL before delivery.
  }
  return '🔗';
}

function decorateActionText(value: string, emoji: string): string {
  return value.startsWith(emoji) ? value : `${emoji} ${value}`;
}

function compactCardBody(value: string): string {
  const compact = value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[ \t]{2,}/g, ' '))
    .filter(Boolean)
    .slice(0, 2)
    .join('\n');
  return compact.length > 180 ? `${compact.slice(0, 179).trimEnd()}…` : compact;
}

function ctaUrlFromCardContent(content: unknown): CtaUrlSpec | null {
  const c = content as Record<string, unknown> | null;
  if (!c || c.type !== 'card' || !c.card || typeof c.card !== 'object') return null;
  const card = c.card as Record<string, unknown>;
  const actions = Array.isArray(card.actions) ? (card.actions as Array<Record<string, unknown>>) : [];
  if (actions.length !== 1) return null;
  const a = actions[0];
  const url = typeof a.url === 'string' ? a.url : '';
  const label = typeof a.label === 'string' ? a.label : '';
  if (!url || !label || !/^https:\/\//i.test(url)) return null;
  const title = typeof card.title === 'string' ? card.title : '';
  const parts: string[] = [];
  if (typeof card.description === 'string' && card.description) parts.push(card.description);
  if (Array.isArray(card.children)) {
    for (const ch of card.children as unknown[]) {
      if (typeof ch === 'string' && ch) parts.push(ch);
      else if (ch && typeof ch === 'object' && typeof (ch as Record<string, unknown>).text === 'string') {
        parts.push((ch as Record<string, string>).text);
      }
    }
  }
  let body = parts.join('\n\n').trim();
  if (!body) body = typeof c.fallbackText === 'string' && c.fallbackText ? c.fallbackText : title;
  if (!body) body = title || label;
  body = compactCardBody(body);
  const emoji = actionEmojiForUrl(url);
  return {
    body,
    header: decorateActionText(title || 'פעולה', emoji).slice(0, 60),
    displayText: decorateActionText(label || 'פתח', emoji).slice(0, 20),
    url,
  };
}

async function sendCtaUrlViaCloudApi(toNumber: string, cta: CtaUrlSpec): Promise<string | undefined> {
  const env = readEnvFile(['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WhatsApp Cloud credentials missing for cta_url send');
  const interactive: Record<string, unknown> = {
    type: 'cta_url',
    body: { text: cta.body },
    action: { name: 'cta_url', parameters: { display_text: cta.displayText, url: cta.url } },
  };
  if (cta.header) interactive.header = { type: 'text', text: cta.header };
  const res = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toNumber,
      type: 'interactive',
      interactive,
    }),
  });
  const sent = (await res.json()) as { messages?: { id: string }[]; error?: { message?: string } };
  if (!res.ok || !sent.messages?.length) {
    throw new Error(`WhatsApp cta_url send failed: ${sent.error?.message ?? res.status}`);
  }
  return sent.messages[0].id;
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
        // Before provisioning, mirroring, activation or automatic replies.
        const loopReason = whatsappInboundBlockReason({
          channelType: CHANNEL_TYPE, instance: INSTANCE, platformId, threadId,
          message: { ...inbound, content: JSON.stringify(inbound.content) },
        });
        if (loopReason) {
          log.warn('WhatsApp agent loop blocked before provisioning', { reason: loopReason, messageId: inbound.id });
          return;
        }

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
              let activationCode = findPilotCodeInText(text);
              const userId = `whatsapp:${sender}`;

              // Walk-up consent binding (2026-10-06). We are inside the Chat
              // SDK's onInbound, which @chat-adapter/whatsapp invokes only
              // AFTER X-Hub-Signature-256 verified (dist/index.js
              // handleWebhook → verifySignature → 401 otherwise), so `sender`
              // is the verified phone. Bind nonce → verified phone atomically
              // and write the consent row in the same transaction. A storage
              // failure blocks continuation (no provisioning, nonce stays
              // pending so the same message can be retried). A nonce resolves
              // to its activation code, so the landing may drop the code line.
              const consentNonce = findConsentNonceInText(text);
              if (consentNonce) {
                let bind;
                try {
                  bind = bindConsentNonce(consentNonce, userId);
                } catch (err) {
                  log.error('WhatsApp Cloud consent bind: storage failure — blocked', { err, userId });
                  await sendText(platformId, consentFeedback('storageFailure', text));
                  return;
                }
                if (bind.status === 'phone-mismatch') {
                  log.warn('WhatsApp Cloud consent bind rejected: nonce bound to another phone', { userId });
                  await sendText(platformId, consentFeedback('phoneMismatch', text));
                  return;
                }
                if (bind.status === 'expired') {
                  log.warn('WhatsApp Cloud consent nonce expired', { userId });
                  await sendText(platformId, consentFeedback('expired', text));
                  return;
                }
                if (bind.status === 'unknown') {
                  log.warn('WhatsApp Cloud consent nonce unknown — treating as plain walk-up', { userId });
                } else {
                  log.info('WhatsApp Cloud consent bound', {
                    userId,
                    policyVersion: bind.row.policy_version,
                    idempotent: bind.status === 'already-bound',
                  });
                  activationCode = activationCode ?? bind.row.activation_code;
                }
              }
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
                  const prov = await provisionPilotAtPress({
                    activation: consumed,
                    fallbackName: senderName || null,
                    boardUserId: senderNumberFromPlatformId(platformId),
                    channel: 'WhatsApp',
                      whatsappInstance: 'whatsapp-cloud',
                  });
                  // Greeting BEFORE wiring — guarantees it's the first
                  // message on every new agent (Telegram parity). Mirrors the
                  // master template's own opening line (pilot_agent_script_v2.md,
                  // "הפתיחה והזרימה") — short, no "world is moving to agents"
                  // pitch, straight to a scenario-forcing question. Replaces the
                  // old 3-part pitch per pending_after_wa_e2e.md item 1 (Elia,
                  // 2026-08-03 #63062), implemented once WA Cloud E2E was verified.
                  const greetName = prov.userName !== 'User' ? prov.userName : null;
                  // Agent4Job pilots (profile-first): the opening is the script's own
                  // line, word for word (joni_onboarding_script_v1.md, שלב 1), first
                  // name only, no emoji. The script then does not greet again.
                  // Other pilots keep the legacy greeting. (Elia, 2026-10-05)
                  const first = greetName ? greetName.trim().split(/\s+/)[0] : null;
                  await sendText(
                    platformId,
                    prov.profileFirstGreeting !== undefined
                      ? prov.lang === 'en'
                        ? `Hi${first ? ` ${first}` : ''}, happy to get going with you. Where do we start? The fastest way is to send me your CV.`
                        : `היי${first ? ` ${first}` : ''}, אשמח לצאת איתך לדרך. מאיפה מתחילים? הכי מהיר זה לשלוח לי קורות חיים.`
                      : prov.lang === 'en'
                        ? `Hi${greetName ? ` ${greetName}` : ''}, I'm Johnny. Elia developed me just for you. 👋 What's on your mind today — anything we can work on together?`
                        : `היי${greetName ? ` ${greetName}` : ''}, אני ג'וני. אליה פיתח אותי במיוחד בשבילך. 👋 מה הכי מעסיק אותך היום, יש משהו שנעבוד עליו יחד?`,
                  );
                  wireJoniChat(platformId, prov.agentGroupId, userId, senderName || prov.userName, CHANNEL_TYPE);
                  stampInstance(platformId);
                  getDb()
                    .prepare('UPDATE pilot_activations SET agent_group_id = ? WHERE code = ?')
                    .run(prov.agentGroupId, activationCode);
                  // Attribution rescue (2026-08-05): if the signup form didn't
                  // carry a src (main-page signups) but the arriving message
                  // text DOES carry a campaign tag, persist it into the
                  // activation metadata — the panel reads source from there,
                  // and these were landing as "לא ידוע". Best-effort.
                  try {
                    const textSrc = parseWalkupAttribution(text).src;
                    if (textSrc) {
                      const row = getDb()
                        .prepare('SELECT metadata FROM pilot_activations WHERE code = ?')
                        .get(activationCode) as { metadata: string | null } | undefined;
                      const meta = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
                      if (!meta.src) {
                        meta.src = textSrc;
                        getDb()
                          .prepare('UPDATE pilot_activations SET metadata = ? WHERE code = ?')
                          .run(JSON.stringify(meta), activationCode);
                        log.info('WhatsApp Cloud: src recovered from message text', { src: textSrc, slug: prov.slug });
                      }
                    }
                  } catch (err) {
                    log.warn('WhatsApp Cloud: src-from-text rescue failed (non-fatal)', { err });
                  }
                  log.info('WhatsApp Cloud pilot provisioned via activation code', {
                    slug: prov.slug,
                    agentGroupId: prov.agentGroupId,
                    userId,
                  });
                  return; // code message consumed
                } else {
                  // Walk-up gate (2026-10-06): a code-less, nonce-less first
                  // contact provisions ONLY when a consent_records row is
                  // already bound to this verified phone. Read failure →
                  // block (nothing is created). WALKUP_CONSENT_GATE=off
                  // restores the old behaviour for staging.
                  if (walkupConsentGateEnabled()) {
                    let consented: boolean;
                    try {
                      consented = hasConsentRecordForUser(userId);
                    } catch (err) {
                      log.error('WhatsApp Cloud walk-up gate: storage failure — blocked', { err, userId });
                      await sendText(platformId, consentFeedback('storageFailure', text));
                      return;
                    }
                    if (!consented) {
                      log.warn('WhatsApp Cloud walk-up blocked: no consent record for sender', { userId });
                      await sendText(platformId, consentFeedback('needsConsent', text));
                      return;
                    }
                  }
                  // Walk-up flow: first message with no code. Mint + consume a
                  // real activation row (not a synthetic one) so the dashboard
                  // gets name/source attribution — the landing's code-less
                  // pre-fill carries both in the text itself.
                  const attr = parseWalkupAttribution(text);
                  // Code-less contact still gets the job-search pilot (same
                  // script as the landing flow) and Hebrew unless clearly English.
                  const walkupSrc = attr.src ?? walkupDefaultSrc();
                  const minted = createActivation({
                    lang: walkupLang(text),
                    metadata: {
                      name: attr.name || senderName || null,
                      gender: 'm',
                      ...(walkupSrc ? { src: walkupSrc } : {}),
                    },
                  });
                  const consumed = consumeActivation(minted.code, {
                    userId,
                    agentGroupId: `pending-${Date.now()}`,
                  });
                  if (!consumed) throw new Error('walk-up activation consume failed');
                  const prov = await provisionPilotAtPress({
                    activation: consumed,
                    fallbackName: attr.name || senderName || null,
                    boardUserId: senderNumberFromPlatformId(platformId),
                    channel: 'WhatsApp',
                      whatsappInstance: 'whatsapp-cloud',
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
                    source: walkupSrc,
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
      // Native URL button (isolated add-on): a single-action https-link card
      // becomes a WhatsApp interactive cta_url instead of flattening to text.
      const ctaSpec = ctaUrlFromCardContent(message.content);
      if (ctaSpec) {
        const toNumber = senderNumberFromPlatformId(platformId);
        if (toNumber) {
          const ctaId = await sendCtaUrlViaCloudApi(toNumber, ctaSpec);
          log.info('WhatsApp Cloud cta_url sent', { platformId, url: ctaSpec.url });
          try {
            const slug = resolvePilotSlug(platformId);
            if (slug) {
              const mirrored = outboundMirrorText(message);
              if (mirrored) mirrorToSupervisor(slug, 'agent', mirrored);
            }
          } catch (err) {
            log.warn('WhatsApp Cloud cta_url mirror failed', { err, platformId });
          }
          return ctaId;
        }
      }
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
      let result: string | undefined;
      let deliveredVoice = false;
      if (voiceRepliesEnabled()) {
        const toNumber = senderNumberFromPlatformId(platformId);
        const text = spokenText(message);
        if (toNumber && text) {
          const audio = await synthesizeSpeech(text);
          if (audio) {
            try {
              await sendVoiceViaCloudApi(toNumber, audio);
              deliveredVoice = true;
            } catch (err) {
              log.warn('WhatsApp Cloud voice reply failed; falling back to text', { platformId, err });
            }
          }
        }
      }
      if (!deliveredVoice) result = await bridge.deliver(platformId, threadId, message);
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
