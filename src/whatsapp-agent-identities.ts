/** Provider-confirmed sending accounts, never the contact/customer phone.
 * Track A is opt-in for staging; no external alert messages are sent.
 */
import { getDb, hasTable } from './db/connection.js';
import { log } from './log.js';

export function automaticWhatsAppGuard(): boolean {
  return process.env.WHATSAPP_LOOP_GUARD === '1';
}
function fail(code: string, subject: string): never {
  log.error('ALERT: WhatsApp loop guard blocked an unregistered identity', { code, subject });
  const db = getDb();
  if (hasTable(db, 'whatsapp_loop_alerts'))
    db.prepare(
      `
    INSERT INTO whatsapp_loop_alerts(code,subject,last_seen) VALUES (?,?,?)
    ON CONFLICT(code,subject) DO UPDATE SET occurrences=occurrences+1,last_seen=excluded.last_seen
  `,
    ).run(code, subject, new Date().toISOString());
  throw new Error(`${code}: ${subject}`);
}
function schema(): void {
  if (!hasTable(getDb(), 'whatsapp_agent_accounts') || !hasTable(getDb(), 'whatsapp_agent_bindings'))
    fail('WHATSAPP_IDENTITY_REGISTRY_MISSING', 'migration-required');
}
function normalizePhone(value: string): string | undefined {
  // This input is exclusively provider-confirmed display_phone_number or authenticated socket user.id.
  const number = value
    .split('@')[0]
    .split(':')[0]
    .replace(/[+ ()-]/g, '');
  return /^\d{7,15}$/.test(number) ? number : undefined;
}
export function registerWhatsAppAccount(instance: string, providerPhone: string): void {
  if (!automaticWhatsAppGuard()) return;
  schema();
  const phone = normalizePhone(providerPhone);
  if (!phone) {
    getDb().prepare('UPDATE whatsapp_agent_accounts SET ready=0 WHERE instance=?').run(instance);
    fail('WHATSAPP_AGENT_NUMBER_MISSING', instance);
  }
  const db = getDb();
  const previous = db.prepare('SELECT phone FROM whatsapp_agent_accounts WHERE instance=?').get(instance) as
    | { phone: string }
    | undefined;
  // Account rotation needs explicit revalidation; never silently move every agent to a different number.
  if (previous && previous.phone !== phone) {
    db.prepare('UPDATE whatsapp_agent_accounts SET ready=0 WHERE instance=?').run(instance);
    fail('WHATSAPP_AGENT_ACCOUNT_CHANGED', instance);
  }
  db.prepare(
    `INSERT INTO whatsapp_agent_accounts(instance,phone,verified_at) VALUES (?,?,?)
    ON CONFLICT(instance) DO UPDATE SET verified_at=excluded.verified_at,ready=1`,
  ).run(instance, phone, new Date().toISOString());
}
export function requireWhatsAppAccount(instance: string): void {
  if (!automaticWhatsAppGuard()) return;
  schema();
  if (!instance || !getDb().prepare('SELECT 1 FROM whatsapp_agent_accounts WHERE instance=? AND ready=1').get(instance))
    fail('WHATSAPP_AGENT_NUMBER_MISSING', instance || 'unspecified-instance');
}
/** Called in the same transaction as agent creation / wiring. */
export function bindWhatsAppAgent(agentId: string, instance: string): void {
  if (!automaticWhatsAppGuard()) return;
  requireWhatsAppAccount(instance);
  getDb()
    .prepare('INSERT OR IGNORE INTO whatsapp_agent_bindings(agent_group_id,instance,created_at) VALUES (?,?,?)')
    .run(agentId, instance, new Date().toISOString());
}
export function requireWhatsAppBinding(agentId: string, instance: string): void {
  if (!automaticWhatsAppGuard()) return;
  requireWhatsAppAccount(instance);
  if (
    !getDb()
      .prepare('SELECT 1 FROM whatsapp_agent_bindings WHERE agent_group_id=? AND instance=?')
      .get(agentId, instance)
  )
    fail('WHATSAPP_AGENT_NUMBER_UNREGISTERED', agentId);
}
export function registeredWhatsAppAccounts(): { phone: string; agents: string[] }[] {
  schema();
  const rows = getDb()
    .prepare(
      `SELECT a.instance,a.phone,b.agent_group_id FROM whatsapp_agent_accounts a
    LEFT JOIN whatsapp_agent_bindings b ON b.instance=a.instance`,
    )
    .all() as { instance: string; phone: string; agent_group_id: string | null }[];
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const ids = map.get(r.phone) ?? new Set<string>();
    // Block a confirmed sending account even before its first pilot is provisioned.
    ids.add(r.agent_group_id ?? `account:${r.instance}`);
    map.set(r.phone, ids);
  }
  return [...map].map(([phone, agents]) => ({ phone, agents: [...agents] }));
}
/** Authenticated Graph account lookup. No token or provider response is logged. */
export async function discoverWhatsAppCloudAccount(
  instance: string,
  phoneId: string,
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!automaticWhatsAppGuard()) return;
  if (!/^\d+$/.test(phoneId) || !accessToken) fail('WHATSAPP_AGENT_NUMBER_MISSING', instance);
  let displayPhone: string | undefined;
  try {
    const response = await request(`https://graph.facebook.com/v25.0/${phoneId}?fields=id,display_phone_number`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    const body = (await response.json()) as { id?: string; display_phone_number?: string };
    if (response.ok && body.id === phoneId && typeof body.display_phone_number === 'string')
      displayPhone = body.display_phone_number;
  } catch {
    /* Alert below without leaking URL, headers or response payload. */
  }
  if (!displayPhone) fail('WHATSAPP_AGENT_NUMBER_DISCOVERY_FAILED', instance);
  registerWhatsAppAccount(instance, displayPhone);
}

/** Covers pilots created through generic CLI/API then attached to a WhatsApp account. */
export function bindWhatsAppWiring(agentId: string, messagingGroupId: string): void {
  if (!automaticWhatsAppGuard()) return;
  const mg = getDb().prepare('SELECT channel_type,instance FROM messaging_groups WHERE id=?').get(messagingGroupId) as
    | { channel_type: string; instance: string }
    | undefined;
  if (mg?.channel_type === 'whatsapp') bindWhatsAppAgent(agentId, mg.instance);
}
