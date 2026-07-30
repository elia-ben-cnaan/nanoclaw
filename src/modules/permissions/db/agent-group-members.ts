import type { AgentGroupMember } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

export function addMember(row: AgentGroupMember): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (@user_id, @agent_group_id, @added_by, @added_at)`,
    )
    .run(row);
}

export function removeMember(userId: string, agentGroupId: string): void {
  getDb().prepare('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?').run(userId, agentGroupId);
}

export function getMembers(agentGroupId: string): AgentGroupMember[] {
  return getDb()
    .prepare('SELECT * FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at')
    .all(agentGroupId) as AgentGroupMember[];
}

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 */
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}

/**
 * Latest membership row for a user, if any. Used by the WhatsApp provisioning
 * guard to route a returning sender back to their existing agent instead of
 * minting a duplicate (parity with Telegram's findActivePilotByUser path,
 * which walk-up WhatsApp users never enter — their synthetic activation is
 * never persisted).
 */
export function getLatestMembershipByUser(userId: string): AgentGroupMember | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_group_members WHERE user_id = ? ORDER BY added_at DESC LIMIT 1')
    .get(userId) as AgentGroupMember | undefined;
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. */
export function hasMembershipRow(userId: string, agentGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}
