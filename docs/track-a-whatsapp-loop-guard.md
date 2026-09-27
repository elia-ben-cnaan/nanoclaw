# Track A: automatic WhatsApp agent identities (staging only)

Two separate WhatsApp accounts can make agent output look like human input to the other account. `fromMe=false` is expected in this case. The host now recognizes its own sending accounts before pilot provisioning, automatic acknowledgements, routing and wake.

## Staging activation

This change is inactive until `WHATSAPP_LOOP_GUARD=1` is set on an isolated staging process. Apply migration `whatsapp-agent-identities` only to its staging DB. No live process, restart, production migration or account test is authorized by this patch. Production rollout requires Daniela's coordinated GO.

There is no manual phone-list configuration. The old `WHATSAPP_LOOP_POLICY_FILE` mechanism is no longer read. The adapter registers its authenticated sending identity automatically:

- Native WhatsApp: authenticated Baileys `sock.user.id`.
- Cloud: authenticated Graph lookup of the configured phone-number ID, verifying the returned ID before accepting `display_phone_number`. Lookup failure prevents setup. The ten-second request is mocked in tests.
- Pilot creation binds the new agent to its host adapter instance atomically, before filesystem initialization or a reply. The activation's contact/customer phone is never registered as the agent's number.
- Generic agents attached later through wiring are bound by the wiring transaction, including the CLI path. Existing unbound agents are not silently treated as safe; inbound/outbound checks reject them and alert.

One physical account can serve many agents. Registered account identities block peer-agent input even before their first pilot is created. Deleting a pilot removes its binding through the foreign key, but keeps the sending-account identity: deleting a pilot must not make a still-connected account look human.

## Guard and alert behavior

Known-account input stops after one external crossing, before the receiving agent produces a reply. No user-text origin or hop claims are trusted. Content+source dedup is scoped to instance/chat and has a 60-second, 10,000-entry bound. Cache loss does not reopen the loop because account recognition is persistent.

The routing graph combines internal destinations, external WhatsApp peers and origin-chat wiring. A cycle involving WhatsApp is rejected atomically; internal-only cycles and unrelated routes remain allowed. Delivery rechecks the graph and binding, covering stale projections and direct DB writes.

Missing identity fails closed with an ERROR-level `ALERT` and a stable code:

- `WHATSAPP_AGENT_NUMBER_MISSING`: unknown/missing/quarantined adapter identity.
- `WHATSAPP_AGENT_NUMBER_UNREGISTERED`: agent has no binding to its WhatsApp instance.
- `WHATSAPP_AGENT_NUMBER_DISCOVERY_FAILED`: authenticated account lookup failed.
- `WHATSAPP_AGENT_ACCOUNT_CHANGED`: account rotation requires revalidation; the instance is quarantined.
- `WHATSAPP_IDENTITY_REGISTRY_MISSING`: migration absent.

Alerts are upserted into `whatsapp_loop_alerts` with occurrence counts and last-seen timestamps. If a caller's transaction rolls back, its DB alert may roll back too; the structured ERROR log remains. No WhatsApp alert/ack is sent back into the loop, and no external notification service is invoked.

Messages manually typed from an account used by an agent are also blocked. The provider does not reliably distinguish them. Unmanaged third-party bot numbers cannot be identified automatically; all participating managed adapters must run this guard. LID-only identities must be resolved by the adapter's existing translation before phone matching.

## Local acceptance

From an isolated checkout with development dependencies:

```sh
./node_modules/.bin/tsx src/whatsapp-loop-dry-run.ts
./node_modules/.bin/vitest run src/whatsapp-auto-registration.test.ts src/whatsapp-loop-guard.test.ts src/whatsapp-loop-router.test.ts src/channels/whatsapp-loop-provisioning.test.ts src/db/messaging-groups-instance.test.ts src/cli/resources/destinations.test.ts src/cli/resources/messaging-groups.test.ts src/delivery.test.ts --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/tsc --noEmit
```

The dry-run creates UUID-based temporary agent IDs and its own scratch SQLite database under `work/`. It exercises actual creation, identity persistence and inbound routing using simulated provider accounts. Each direction crosses once with zero agent replies. Missing-number creation and an existing unbound agent both alert and reject. The scratch database is removed in `finally`. No sockets, real sends, live credentials or container wake are started.

57 tests across eight files pass, including actual pilot-provisioning registration, customer-number separation, identity discovery failure, missing registry, quarantine, automatic graph checks, CLI bypass prevention, and the unguarded negative-control loop. This is local validation, not a live two-account acceptance test.

## Review and rollback boundary

This branch is based on a local server snapshot; the custom provisioning and Cloud wrapper files are absent from the currently inspected public repository bases. An authoritative repository and base branch are required before publishing or rebasing the patch. Do not upload the whole snapshot to fill that gap.

No production state has been changed. Local failure rollback removes the scratch DB; code changes remain on the review branch. Migration reversal or disabling the guard on a running host is a separate production action, not part of this task.
