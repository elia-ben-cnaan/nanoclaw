/**
 * Language-selection regression test for pilot provisioning.
 *
 * The signup form carries a `lang` field (he | en). This test pins the one
 * behavior that decides the new agent's opening language: the seed string
 * `provisionPilotAtPress` writes into the group filesystem. DB + fs side
 * effects are mocked so nothing touches the live install — we only capture
 * the `instructions` handed to initGroupFilesystem and assert its language.
 */
import { describe, it, expect, vi } from 'vitest';

import type { PilotActivation } from './modules/pilot-activation/db.js';

// Capture the seed instructions written for the new agent.
let capturedInstructions = '';

vi.mock('./group-init.js', () => ({
  initGroupFilesystem: (_group: unknown, opts: { instructions: string }) => {
    capturedInstructions = opts.instructions;
  },
}));
vi.mock('./db/agent-groups.js', () => ({
  createAgentGroup: () => {},
  getAgentGroup: () => null,
  getAgentGroupByFolder: () => null,
}));
vi.mock('./db/container-configs.js', () => ({
  ensureContainerConfig: () => {},
  updateContainerConfigScalars: () => {},
}));
vi.mock('./db/usage-metering.js', () => ({ setCostCapUsd: () => {} }));
vi.mock('./db/sessions.js', () => ({ findSessionByAgentGroup: () => null }));
vi.mock('./modules/agent-to-agent/db/agent-destinations.js', () => ({
  createDestination: () => {},
  getDestinationByName: () => null,
}));
vi.mock('./modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: () => {} }));

import { provisionPilotAtPress } from './provision-handler.js';

function activation(lang: 'he' | 'en', gender: 'm' | 'f' = 'm'): PilotActivation {
  return {
    code: 'TESTCODE',
    lang,
    metadata: JSON.stringify({ name: 'Dana', gender }),
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

describe('provisionPilotAtPress — opening language follows signup lang', () => {
  it('en signup → seed instructs English communication, not Hebrew', () => {
    capturedInstructions = '';
    const res = provisionPilotAtPress({ activation: activation('en') });
    expect(res.lang).toBe('en');
    // The identity block must tell the agent to open + speak English.
    expect(capturedInstructions).toContain('Open the conversation in English');
    expect(capturedInstructions).toContain('keep communicating in English');
    // Regression guard: the old bug told English users to "Speak to them in Hebrew".
    expect(capturedInstructions).not.toContain('Speak to them in Hebrew');
    // Regression guard: the persona/onboarding script is Hebrew-only and used
    // to leak into English seeds unmarked, with a literal Hebrew "automatic"
    // opening line competing against the English directive above it.
    expect(capturedInstructions).toContain('Language override for everything below');
    expect(capturedInstructions).toContain('write every message, starting with the');
  });

  it('he signup → seed stays Hebrew (default unchanged)', () => {
    capturedInstructions = '';
    const res = provisionPilotAtPress({ activation: activation('he') });
    expect(res.lang).toBe('he');
    expect(capturedInstructions).toContain('דבר/י אליו/אליה בעברית');
    // The English-only override note must not appear for Hebrew signups.
    expect(capturedInstructions).not.toContain('Language override for everything below');
  });

  it('missing/invalid lang → defaults to Hebrew', () => {
    capturedInstructions = '';
    const act = activation('he');
    // Simulate a bad value slipping through the type.
    (act as unknown as { lang: string }).lang = 'xx';
    const res = provisionPilotAtPress({ activation: act });
    expect(res.lang).toBe('he');
    expect(capturedInstructions).toContain('דבר/י אליו/אליה בעברית');
  });
});
