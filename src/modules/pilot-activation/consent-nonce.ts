/**
 * Walk-up consent binding — nonce contract (Shellanoo spec, 2026-10-06).
 *
 * Flow:
 *   1. /provision accepts a known policyVersion → mints an activation code
 *      (as before) PLUS a consent nonce bound to that code. The nonce rides
 *      as the LAST line of the wa.me pre-filled text ("ref: cn_…"), which the
 *      landing preserves when it swaps the opener.
 *   2. The WhatsApp Cloud pilot interceptor (runs inside the Chat SDK's
 *      onInbound, i.e. only after the SDK verified X-Hub-Signature-256) finds
 *      the nonce in the first inbound text and binds it to the verified
 *      sender id "whatsapp:<number>" — atomically, single-use.
 *   3. On a successful bind ONE consent_records row is written (keyed by the
 *      activation code, so the later consumeActivation() upsert hits the same
 *      row — never two). No IP, no user agent.
 *   4. The code-less walk-up path provisions ONLY when a consent_records row
 *      exists for that verified sender.
 *
 * Nonce format: "cn_" + 22 base64url chars (16 random bytes = 128 bits).
 * Opaque, unguessable, visually distinct from the 20-char uppercase pilot
 * code alphabet so the two extractors never collide. TTL 24h (same as the
 * activation code it belongs to).
 */
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';

export const CONSENT_NONCE_PREFIX = 'cn_';
export const CONSENT_NONCE_BODY_LENGTH = 22; // base64url of 16 bytes, unpadded
export const CONSENT_NONCE_TTL_HOURS = 24;

export interface ConsentNonceRow {
  nonce: string;
  activation_code: string;
  policy_version: string;
  consented_at: string;
  source: string | null;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'bound';
  bound_user_id: string | null;
  bound_at: string | null;
}

export type ConsentBindResult =
  | { status: 'bound'; row: ConsentNonceRow }
  /** Same verified phone re-sent the same nonce (retry / duplicate webhook). */
  | { status: 'already-bound'; row: ConsentNonceRow }
  /** Nonce already bound to a DIFFERENT verified phone — never re-bind. */
  | { status: 'phone-mismatch'; row: ConsentNonceRow }
  | { status: 'expired'; row: ConsentNonceRow }
  | { status: 'unknown' };

export function generateConsentNonce(): string {
  return CONSENT_NONCE_PREFIX + crypto.randomBytes(16).toString('base64url');
}

const NONCE_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_-])(${CONSENT_NONCE_PREFIX}[A-Za-z0-9_-]{${CONSENT_NONCE_BODY_LENGTH}})(?![A-Za-z0-9_-])`,
);

export function looksLikeConsentNonce(candidate: string): boolean {
  return new RegExp(`^${CONSENT_NONCE_PREFIX}[A-Za-z0-9_-]{${CONSENT_NONCE_BODY_LENGTH}}$`).test(candidate);
}

/** First consent nonce anywhere in a message text, or null. */
export function findConsentNonceInText(text: string): string | null {
  const m = text.match(NONCE_RE);
  return m ? m[1] : null;
}

/**
 * The trailing line carrying the nonce in the wa.me pre-fill. The landing
 * keeps exactly this line (regex below) when it replaces the opener, so the
 * user sees the token once, at the bottom of their own first message.
 */
export function consentNonceLine(nonce: string): string {
  return `ref: ${nonce}`;
}

/** Line-level matcher the landing mirrors (kept here as the single source of truth). */
export const CONSENT_NONCE_LINE_RE = /^ref:\s*(cn_[A-Za-z0-9_-]{22})\s*$/m;

export function createConsentNonce(input: {
  activationCode: string;
  policyVersion: string;
  consentedAt: string;
  source?: string | null;
  now?: Date;
}): ConsentNonceRow {
  const now = input.now ?? new Date();
  const row: ConsentNonceRow = {
    nonce: generateConsentNonce(),
    activation_code: input.activationCode,
    policy_version: input.policyVersion,
    consented_at: input.consentedAt,
    source: input.source ?? null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CONSENT_NONCE_TTL_HOURS * 3600 * 1000).toISOString(),
    status: 'pending',
    bound_user_id: null,
    bound_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO consent_nonces (nonce, activation_code, policy_version, consented_at, source, created_at, expires_at, status)
       VALUES (@nonce, @activation_code, @policy_version, @consented_at, @source, @created_at, @expires_at, @status)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return row;
}

export function getConsentNonce(nonce: string): ConsentNonceRow | undefined {
  return getDb().prepare('SELECT * FROM consent_nonces WHERE nonce = ?').get(nonce) as ConsentNonceRow | undefined;
}

/**
 * Atomically bind a nonce to the verified sender and write the consent row.
 * Both statements run in one transaction: either the nonce is bound AND the
 * consent_records row exists, or nothing changed. Storage errors propagate
 * (the caller must treat them as "block continuation").
 *
 * Idempotency: a second message from the SAME phone with the same nonce
 * returns 'already-bound' and touches nothing. A DIFFERENT phone gets
 * 'phone-mismatch' — the nonce never moves.
 */
export function bindConsentNonce(nonce: string, userId: string, now = new Date()): ConsentBindResult {
  const db = getDb();
  const nowIso = now.toISOString();
  const channel = userId.includes(':') ? userId.slice(0, userId.indexOf(':')) : 'unknown';
  const run = db.transaction((): ConsentBindResult => {
    const result = db
      .prepare(
        `UPDATE consent_nonces
         SET status = 'bound', bound_user_id = @userId, bound_at = @now
         WHERE nonce = @nonce AND status = 'pending' AND expires_at > @now`,
      )
      .run({ nonce, userId, now: nowIso });
    const row = getConsentNonce(nonce);
    if (!row) return { status: 'unknown' };
    if (result.changes === 1) {
      db.prepare(
        `INSERT INTO consent_records (activation_code, policy_version, consented_at, source, user_id, channel, bound_at)
         VALUES (@code, @policyVersion, @consentedAt, @source, @userId, @channel, @boundAt)
         ON CONFLICT(activation_code) DO UPDATE SET user_id = excluded.user_id, channel = excluded.channel,
           bound_at = excluded.bound_at`,
      ).run({
        code: row.activation_code,
        policyVersion: row.policy_version,
        consentedAt: row.consented_at,
        source: row.source,
        userId,
        channel,
        boundAt: nowIso,
      });
      return { status: 'bound', row };
    }
    if (row.status === 'bound') {
      return row.bound_user_id === userId ? { status: 'already-bound', row } : { status: 'phone-mismatch', row };
    }
    return { status: 'expired', row };
  });
  return run();
}

/** True when a consent_records row is bound to this verified sender id. */
export function hasConsentRecordForUser(userId: string): boolean {
  const row = getDb().prepare('SELECT 1 AS one FROM consent_records WHERE user_id = ? LIMIT 1').get(userId);
  return row !== undefined;
}

/**
 * Walk-up consent gate switch. Default ON (the policy promises consent
 * logging). WALKUP_CONSENT_GATE=off restores the pre-2026-10-06 behaviour
 * (code-less first contact provisions without a consent row) — staging only.
 */
export function walkupConsentGateEnabled(): boolean {
  const v = (process.env.WALKUP_CONSENT_GATE ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}
