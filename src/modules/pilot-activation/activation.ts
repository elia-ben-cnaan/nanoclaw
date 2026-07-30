/**
 * Telegram START handler for pilot activation (v2 — deep-link codes).
 *
 * The telegram-pilot adapter's inbound interceptor calls tryActivatePilot()
 * on every DM text, BEFORE the legacy 4-digit pairing path. Non-matching
 * text falls through (returns false); a matching `/start <20-char code>` is
 * consumed here and never reaches the router or an agent.
 *
 * Provisioning itself is supplied by the caller via hooks, so this module
 * stays independent of the install's provisioning stack (model pinning,
 * cost caps, supervisor wiring, greeting copy all live with the caller):
 *
 *  - valid pending code   → hooks.activate() — create + wire + greet
 *  - user already active  → hooks.alreadyActive() — rewire chat, no new agent
 *  - expired / used / unknown code → friendly "request a new link" reply
 */
import { log } from '../../log.js';
import {
  consumeActivation,
  findActivePilotByUser,
  getActivation,
  isExpired,
  looksLikePilotCode,
  type PilotActivation,
  type PilotLang,
} from './db.js';

export interface ActivationContext {
  /** DM platform id, e.g. "telegram:12345" (chat id == user id for DMs). */
  platformId: string;
  /** Namespaced user id, e.g. "telegram-pilot:12345". */
  userId: string;
  /** Sender display name from the Telegram profile, if known. */
  displayName: string | null;
}

export interface ActivationHooks {
  /**
   * Provision an agent for a freshly-consumed activation and greet the user.
   * Must return the created agent group id (stamped onto the activation row).
   * Throwing re-opens the code so the user can retry the same link.
   */
  activate(consumed: PilotActivation, ctx: ActivationContext): Promise<string>;
  /**
   * The user already has an active pilot — point this chat at the existing
   * agent (idempotent) and tell the user. Never creates anything.
   */
  alreadyActive(existing: PilotActivation, ctx: ActivationContext): Promise<void>;
}

export interface ActivationInput {
  /** Full message text, e.g. "/start ABCD…". */
  text: string;
  platformId: string;
  /** Namespaced user id of the sender, or null when unresolvable. */
  userId: string | null;
  displayName?: string | null;
  /** True when the message came from a group chat — activation is DM-only. */
  isGroup: boolean;
  /** Send a plain text to the chat via the bot API (feedback messages). */
  sendText: (text: string) => Promise<void>;
  hooks: ActivationHooks;
}

/** Extract a pilot code from "/start <code>" (or a bare pasted code). */
export function extractPilotCode(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/start\s+(\S+)$/) ?? trimmed.match(/^(\S+)$/);
  if (!m) return null;
  return looksLikePilotCode(m[1]) ? m[1] : null;
}

/**
 * Find a pilot code ANYWHERE inside a longer message. Used by the WhatsApp
 * deep-link flow, where wa.me pre-fills a friendly greeting with the code
 * embedded at the end ("היי ג'וני ... קוד הפעלה: XXXX") — the message is no
 * longer just the bare code. The code alphabet (uppercase, no 0/O/1/I,
 * length 20) makes accidental matches in natural text practically
 * impossible. Falls back to the strict extractor first so bare codes and
 * "/start CODE" keep working identically.
 */
export function findPilotCodeInText(text: string): string | null {
  const strict = extractPilotCode(text);
  if (strict) return strict;
  for (const token of text.split(/[^A-Z0-9]+/)) {
    if (looksLikePilotCode(token)) return token;
  }
  return null;
}

/**
 * Best-effort language detection for walk-up messages (no signup form, so no
 * `lang` field). Any Hebrew letter wins → 'he'; otherwise Latin letters →
 * 'en'; anything else (emoji, digits, empty) defaults to 'he' per product
 * spec. Deliberately character-class based — no dependency, no network.
 */
export function detectLang(text: string): PilotLang {
  if (/[֐-׿]/.test(text)) return 'he';
  if (/[a-zA-Z]/.test(text)) return 'en';
  return 'he';
}

const FEEDBACK = {
  expired: {
    he: 'הקישור הזה פג תוקף (קישורים תקפים ל-24 שעות). אפשר לבקש קישור חדש בטופס ההרשמה באתר ונשלח לך אחד מיד. 🙂',
    en: "This link has expired (links are valid for 24 hours). Request a new link from the signup form on the site and we'll send you one right away. 🙂",
  },
  alreadyUsed: {
    he: 'הקוד הזה כבר נוצל. אם זה לא היית אתה — בקש קישור חדש בטופס ההרשמה באתר.',
    en: "This code has already been used. If that wasn't you — request a new link from the signup form on the site.",
  },
  unknown: {
    he: 'הקוד הזה לא מוכר. בקש קישור חדש בטופס ההרשמה באתר.',
    en: "This code isn't recognized. Please request a new link from the signup form on the site.",
  },
  provisioningFailed: {
    he: 'משהו השתבש בהקמת הסוכנת — נסה ללחוץ על הקישור שוב בעוד דקה.',
    en: 'Something went wrong setting up your agent — please try the link again in a minute.',
  },
} as const;

function feedback(key: keyof typeof FEEDBACK, lang: PilotLang): string {
  return FEEDBACK[key][lang];
}

/**
 * Returns true when the message was an activation attempt and was fully
 * handled here (the caller must short-circuit); false to fall through.
 */
export async function tryActivatePilot(input: ActivationInput): Promise<boolean> {
  const code = extractPilotCode(input.text);
  if (!code) return false;

  // A code pasted into a group chat is ignored (activation binds a personal
  // DM). Still counts as handled so the raw code never reaches an agent.
  if (input.isGroup) {
    log.warn('Pilot activation attempted from a group chat — ignored', { platformId: input.platformId });
    return true;
  }

  const activation = getActivation(code);
  const lang: PilotLang = activation?.lang === 'en' ? 'en' : 'he';

  if (!input.userId) {
    log.warn('Pilot activation without resolvable sender id — ignored', { platformId: input.platformId });
    await input.sendText(feedback('unknown', lang));
    return true;
  }

  const ctx: ActivationContext = {
    platformId: input.platformId,
    userId: input.userId,
    displayName: input.displayName ?? null,
  };

  // One active agent per Telegram user: a returning user gets routed to
  // their existing agent, regardless of the new code's validity.
  const existing = findActivePilotByUser(input.userId);
  if (existing?.agent_group_id) {
    log.info('Pilot re-activation — routing to existing agent', {
      userId: input.userId,
      agentGroupId: existing.agent_group_id,
    });
    await input.hooks.alreadyActive(existing, ctx);
    return true;
  }

  if (!activation) {
    await input.sendText(feedback('unknown', lang));
    return true;
  }
  if (activation.status === 'used') {
    await input.sendText(feedback('alreadyUsed', lang));
    return true;
  }
  if (isExpired(activation)) {
    await input.sendText(feedback('expired', lang));
    return true;
  }

  // Consume first (atomic, one-shot) — provisioning happens only for the
  // press that actually won the code.
  const consumed = consumeActivation(code, { userId: input.userId, agentGroupId: `pending-${Date.now()}` });
  if (!consumed) {
    // Lost a race with a concurrent press of the same link.
    await input.sendText(feedback('alreadyUsed', lang));
    return true;
  }

  try {
    const agentGroupId = await input.hooks.activate(consumed, ctx);
    const { getDb } = await import('../../db/connection.js');
    getDb().prepare('UPDATE pilot_activations SET agent_group_id = ? WHERE code = ?').run(agentGroupId, code);
    log.info('Pilot activated', { userId: input.userId, agentGroupId, lang: consumed.lang, code });
  } catch (err) {
    log.error('Pilot provisioning failed after code consume', { userId: input.userId, code, err });
    await input.sendText(feedback('provisioningFailed', consumed.lang));
    // Re-open the code so a retry press can succeed.
    const { getDb } = await import('../../db/connection.js');
    getDb()
      .prepare(
        `UPDATE pilot_activations
         SET status = 'pending', used_by_user_id = NULL, used_at = NULL,
             agent_group_id = NULL, pilot_started_at = NULL, pilot_ends_at = NULL
         WHERE code = ?`,
      )
      .run(code);
  }
  return true;
}
