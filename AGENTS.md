# Agent4Job Server Rules (source of truth)

## Priority order

1. Protect the 60 live groups. The non-job (generic) path must remain byte-for-byte identical. Prove this before any live deployment. Do not restart or reload the process serving those groups.
2. Treat the schema and iron rules as law. groups/dm-with-elia-ben-cnaan/pilot_jobsys/pilot/intel/contracts/profile.schema.json is the profile contract; it has additionalProperties: false, so do not add fields. Install the job brain verbatim. FEED_TOKEN is server-environment-only: never place it in a file, log, chat, test fixture, or agent context; rotate it after implementation.
3. Do not break existing routes or channels.
4. Names and refactors are flexible only after the above constraints are satisfied.

## Blast-radius rules

- All new behavior is behind a job-only gate (src=agent4job); registrations without that source must preserve their existing behavior byte-for-byte.
- Token minting is a soft failure: it must not throw, block onboarding, or alter the generic path when unavailable.
- Verify outbound egress to the central engine before relying on it. Handle expected non-success responses deliberately and without logging credentials.
- Make edits only in the server-snapshot checkout. Use throwaway identifiers and non-live processes for every dry run.
- Never reload, restart, or otherwise alter the live process unless a coordinated, explicit production GO is received. Deployment and restart are HARD STOP 1.

## Notification protocol

At completion of every T0–T5 milestone and at every hard stop, post exactly one concise status event to the central engine using the /progress endpoint, Authorization: Bearer $FEED_TOKEN, and a JSON task/result/note body.

Read FEED_TOKEN only from the server environment. Never echo it or enable shell tracing around this command. /progress is already live; do not rebuild it.
