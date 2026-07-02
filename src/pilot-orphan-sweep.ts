/**
 * Orphan-pilot sweep: clean up pilots that were registered (a provisioning
 * form was submitted, an agent group + a pending pairing code were minted) but
 * never started (the user never pressed START, so no session was ever created
 * and the pairing code went unused). Without this, every abandoned signup
 * leaves a dead agent group + group dir behind forever.
 *
 * Runs from the host sweep tick. Scoped to `pilot-` folders only.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getAgentGroupByFolder, deleteAgentGroup } from './db/agent-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { listPairings, deletePairing, type PairingRecord } from './channels/telegram-pairing.js';
import { log } from './log.js';

/** Grace after registration before an unstarted pilot is swept. Set well
 *  beyond the 15-min pairing TTL so a slow-to-start user is never deleted
 *  mid-onboarding; an orphan lingers at most this long. */
export const ORPHAN_PILOT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A pilot is an orphan when its 'new-agent' pairing is still pending, no
 * session was ever created for the agent group, and the grace has elapsed
 * since registration. Pure predicate so the policy is unit-testable.
 */
export function isOrphanPilotPairing(r: PairingRecord, now: number, graceMs: number, hasSession: boolean): boolean {
  if (r.status !== 'pending') return false;
  if (typeof r.intent !== 'object' || r.intent.kind !== 'new-agent') return false;
  if (!r.intent.folder.startsWith('pilot-')) return false;
  if (hasSession) return false;
  return now - Date.parse(r.createdAt) >= graceMs;
}

/**
 * Delete pilots registered but never started: removes the agent group row,
 * the group directory, and the pairing record. Best-effort and per-record
 * guarded so one failure never aborts the rest of the sweep. Returns the
 * number of orphans swept.
 */
export async function sweepOrphanPilots(now: number = Date.now()): Promise<number> {
  let swept = 0;
  for (const r of listPairings()) {
    if (typeof r.intent !== 'object' || r.intent.kind !== 'new-agent') continue;
    const folder = r.intent.folder;
    try {
      const ag = getAgentGroupByFolder(folder);
      const hasSession = ag ? getSessionsByAgentGroup(ag.id).length > 0 : false;
      if (!isOrphanPilotPairing(r, now, ORPHAN_PILOT_GRACE_MS, hasSession)) continue;

      if (ag) deleteAgentGroup(ag.id);
      const dir = path.resolve(GROUPS_DIR, folder);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      await deletePairing(r.code);
      swept++;
      log.info('Swept orphan pilot (registered, never started)', {
        folder,
        agentGroupId: ag?.id ?? null,
        code: r.code,
        ageHours: Math.round((now - Date.parse(r.createdAt)) / 3_600_000),
      });
    } catch (err) {
      log.warn('Orphan pilot sweep failed for one record (non-fatal)', { folder, err });
    }
  }
  return swept;
}
