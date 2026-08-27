/**
 * Per-number opt-out from WhatsApp pilot auto-provisioning.
 *
 * `WHATSAPP_PILOT_SKIP_PLATFORM_IDS` in .env is a comma-separated list of
 * platform ids (e.g. "whatsapp:1169635132908974:972528738698") whose inbound
 * messages must never trigger pilot auto-provision / re-wiring. This is the
 * supported way to hand a single number over to a manually-wired agent group
 * without the pilot flow reclaiming it: the DB wiring stays whatever the
 * operator set, and removing the id from the env var is the full rollback.
 *
 * Integration (server-side, src/channels/whatsapp-cloud-pilot.ts): call
 * `isPilotSkippedPlatformId(platformId)` at the top of the auto-provision
 * path (before the `isWired` check / `provisionPilotAtPress`) and return
 * early when it's true.
 *
 * The env file is re-read per call via readEnvFile — same pattern as the
 * rest of the channel setup code — so edits to .env take effect on the next
 * inbound message without a restart. The list is tiny; no caching needed.
 */
import { readEnvFile } from '../env.js';

export const WHATSAPP_PILOT_SKIP_ENV = 'WHATSAPP_PILOT_SKIP_PLATFORM_IDS';

export function getPilotSkipPlatformIds(): Set<string> {
  const raw = readEnvFile([WHATSAPP_PILOT_SKIP_ENV])[WHATSAPP_PILOT_SKIP_ENV] ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** True when pilot auto-provisioning must leave this platform id alone. */
export function isPilotSkippedPlatformId(platformId: string): boolean {
  return getPilotSkipPlatformIds().has(platformId);
}
