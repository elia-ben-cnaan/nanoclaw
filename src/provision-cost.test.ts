/**
 * Cost-config regression test for pilot provisioning.
 *
 * Joni is a conversational chat agent; its default model + reasoning effort are
 * the two biggest cost levers. This pins the container-config write that
 * `provisionPilotAtPress` performs at create time: the cheap tier (Haiku) and
 * low reasoning effort. DB + fs side effects are mocked so nothing touches the
 * live install — we only capture the scalars handed to updateContainerConfigScalars.
 */
import { describe, it, expect, vi } from 'vitest';

import type { PilotActivation } from './modules/pilot-activation/db.js';

// Capture the container-config scalars written for the new agent.
let capturedConfig: Record<string, unknown> = {};

vi.mock('./group-init.js', () => ({ initGroupFilesystem: () => {} }));
vi.mock('./db/agent-groups.js', () => ({
  createAgentGroup: () => {},
  getAgentGroup: () => null,
  getAgentGroupByFolder: () => null,
}));
vi.mock('./db/container-configs.js', () => ({
  ensureContainerConfig: () => {},
  updateContainerConfigScalars: (_id: string, updates: Record<string, unknown>) => {
    capturedConfig = updates;
  },
  updateContainerConfigJson: () => {},
}));
vi.mock('./db/usage-metering.js', () => ({ setCostCapUsd: () => {} }));
vi.mock('./db/sessions.js', () => ({ findSessionByAgentGroup: () => null }));
vi.mock('./modules/agent-to-agent/db/agent-destinations.js', () => ({
  createDestination: () => {},
  getDestinationByName: () => null,
}));
vi.mock('./modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: () => {} }));

import { provisionPilotAtPress } from './provision-handler.js';

function activation(): PilotActivation {
  return {
    code: 'TESTCODE',
    lang: 'he',
    metadata: JSON.stringify({ name: 'Dana', gender: 'm' }),
    created_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    status: 'used',
    used_by_user_id: 'telegram:123',
    used_at: new Date().toISOString(),
    agent_group_id: null,
    pilot_started_at: new Date().toISOString(),
    pilot_ends_at: '2026-07-21T00:00:00.000Z',
  };
}

describe('provisionPilotAtPress — pilot cost tier is pinned cheap', () => {
  it('pins the configured pilot model (fleet standard since 2026-08-05: sonnet-4-5, haiku Hebrew glitches)', () => {
    capturedConfig = {};
    provisionPilotAtPress({ activation: activation() });
    expect(capturedConfig.model).toBe('claude-sonnet-4-5');
  });

  it('pins reasoning effort low (not high / unset)', () => {
    capturedConfig = {};
    provisionPilotAtPress({ activation: activation() });
    expect(capturedConfig.effort).toBe('low');
  });
});
