/**
 * Integration test for the whatsapp-cloud channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing
 * the barrel runs whatsapp-cloud.ts's top-level
 * `registerChannelAdapter('whatsapp-cloud', …)`; without the import the
 * channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the
 * registry actually contains the channel. If the `import './whatsapp-cloud.js';`
 * line is deleted, or the barrel fails to evaluate (so the channel genuinely
 * would not register), or `@chat-adapter/whatsapp` isn't installed (the import
 * throws), this goes red — so it also implicitly guards that dependency.
 *
 * The factory returns null without WHATSAPP_ACCESS_TOKEN, so registration is
 * a pure top-level call safe to run at import: no network, no webhook server.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('whatsapp-cloud channel registration', () => {
  it('registers whatsapp-cloud via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('whatsapp-cloud');
  });
});
