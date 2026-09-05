import type { Migration } from './index.js';

/**
 * Per-tenant OneCLI routing: `onecli_url` (+ `onecli_api_key`) on
 * `container_configs`. NULL keeps the previous behavior of falling through
 * to the host-global `ONECLI_URL`. Set per group to bind that tenant's
 * containers to a SEPARATE self-hosted OneCLI stack, so each tenant's
 * external identity (Google/Gmail/calendar/GitHub) stays isolated in its
 * own gateway and no tenant's containers can see another's connections.
 */
export const migration026: Migration = {
  version: 26,
  name: 'container-onecli-url',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN onecli_url TEXT;`);
    db.exec(`ALTER TABLE container_configs ADD COLUMN onecli_api_key TEXT;`);
  },
};
