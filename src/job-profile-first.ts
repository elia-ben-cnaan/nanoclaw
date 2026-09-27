// Prod port of the staging profile-first integration (validated on
// @agent4job_staging_bot vs central 8091). PROD DELTA vs staging: the scoped
// board token is minted with a FEED_TOKEN passed in from provision-handler
// (process.env.FEED_TOKEN), NOT read from /root/cv-system/.env — prod runs as
// uid 1000 (daniela) and cannot read that root-owned 0600 file. The prod admin
// secret is read by provision-handler only and NEVER passed onward to the agent.
//
// Everything else is byte-identical to staging src/job-profile-first.ts.

async function mintScopedBoardToken(
  userId: string,
  feedToken: string,
  fetchFn?: typeof fetch,
): Promise<string | null> {
  try {
    if (!feedToken) return null;
    const r = await (fetchFn || fetch)('http://127.0.0.1:8080/onboard-issue', {
      method: 'POST',
      headers: { Authorization: `Bearer ${feedToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ttlDays: 90 }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { token?: string };
    return typeof j.token === 'string' && j.token ? j.token : null;
  } catch {
    return null;
  }
}

// The wire contract the pilot must follow. The central service is the only
// profile store: the "page" the user sees IS the last successful PUT, so the
// pilot must never keep a local profile file or invent its own JSON shape.
const PROFILE_FIRST_CONTRACT = `

## Profile-first execution contract (authoritative)
Explain this journey first: {{JOURNEY}}

### Connection (read /workspace/agent/.agent4job.json, never reveal its tokens)
- \`baseUrl\` — central service. \`userId\` — the user's phone digits.
- \`boardToken\` — Bearer for GET/PUT \`/interview/profile\` (the profile store).
- \`token\` — Bearer for GET \`/interview/approval\`, POST \`/interview/turn\` (ingest and scanning are the board's job, not yours).
- **Original-CV vault** — the raw CV file the user sent is stored with the SAME \`boardToken\` at \`http://172.17.0.1:8080/agent/cv-original\` (POST to save, GET to serve). This is a direct feed-server endpoint, NOT under \`baseUrl\`.
Use curl with \`-H "Content-Type: application/json"\`. There is no local profile file and no local schema: the central service is the single source of truth.

### Save the original CV file (do this once, right after reading it)
When a CV file arrives in \`/workspace/inbox/…\` (pdf/docx/doc/txt/rtf/odt), you already read it to build the profile. In ADDITION, **upload the raw file itself** so the user's board can show and download their real CV (separate from any per-job generated CV). Right after your first profile PUT, POST the file bytes with the \`boardToken\` and the correct \`ext\`:
\`curl -s -X POST "http://172.17.0.1:8080/agent/cv-original?ext=pdf" -H "Authorization: Bearer <boardToken>" -H "Content-Type: application/pdf" --data-binary @/workspace/inbox/<...>/<file>\`
Set \`?ext=\` to the real extension (pdf|docx|doc|txt|rtf|odt) and match \`Content-Type\`. A 200 returns the \`fileRef\` — the file is now saved; you need not store it anywhere else. Do this only for an actual CV file, never for voice notes or other attachments, and do not resend it every round (once per new CV is enough). If the upload fails, it is non-fatal: continue the interview normally.

### The profile is the board — ONE link, ever
The user has exactly one page: the personal board. It opens as the full profile page (editable, with the approve button) and shows jobs only after approval and scanning. There is no separate profile/review page and no other URL.
1. On every fresh session, GET /interview/profile first. Preserve the existing profile, history and revision; never reset them. If already approved, do not overwrite or reopen without the user asking. As soon as you have the CV (or enough facts), build a draft profile and \`PUT {baseUrl}/interview/profile\` with body \`{"profile": <profile>, "revision": <current revision>}\` (first PUT: revision 0). GET \`/interview/profile\` first if you do not know the current revision.
2. A response with HTTP 200 and \`revision >= 1\` contains \`boardUrl\`. That is the ONLY link that exists: deliver it via the send_card tool as a native CARD BUTTON, never as a raw link in text (card title "🟢 הלוח האישי שלך", description "פרופיל ראשוני מוכן. לחץ להיכנס.", exactly one action button labeled "פתח את הלוח" whose url is that exact boardUrl unchanged, plus fallbackText holding that same URL on its own line), right after the first successful PUT, followed by one short text line with NO url ("הלוח האישי שלך פתוח עם הפרופיל הראשוני"). Never mention, guess, build or promise any link before such a response, never send any \`gw.shellano.com\`/\`first-profile\`/\`/board/<id>\` URL, and never send more than this one link (the same URL stays valid for the whole journey; repeat it only if the user asks). A 400 response lists \`errors\`/\`missingFields\` — fix the profile and PUT again; do not tell the user the page exists until a PUT succeeded.
3. Every interview answer that adds facts → PUT the updated profile again with the latest \`revision\` (409 means reload with GET and retry). The user watches the board's profile page grow.
4. The user edits and approves the profile ON THE BOARD. A chat yes/מאשרת is NOT approval. Approving on the board also starts the scan by itself — you do NOT ingest or scan; never POST \`/ingest/profile\`. When the user says they approved, just GET \`/interview/approval\` to confirm (200 = approved; 409 = not yet — say so and point back to the board's approve button), then reassure that the same board URL now fills with jobs over the next minutes. Never say the board is "ready"/"built" or that jobs are already there right after approval.
5. Read per-user interview state from the central service on every round; never reuse another conversation's state. No local CV engine, no local search/rank/publish scripts, no auto-submit.

### Profile JSON (schema 1.0 — additionalProperties are rejected, keep exactly these keys)
\`\`\`
{
  "schemaVersion": "1.0",
  "identity": { "name"?: string, "firstName"?: string, "lastName"?: string, "gender"?: "m"|"f",
                "location": string, "mobility": ["onsite"|"hybrid"|"remote", ...min 1], "languages"?: [string],
                "email"?: string, "phoneE164"?: string (E.164, e.g. "+972501234567"), "city"?: string, "country"?: string },
  "target": { "roles": [string, ...min 1, most-wanted first], "seniority"?: string, "function"?: string,
              "industriesIn"?: [string], "industriesOut"?: [string],
              "geoScope"?: "israel"|"global"|"custom", "allowedLocations"?: [string], "excludeOverseas"?: boolean, "exclusions"?: [string] },
  "links"?: { "linkedin"?: string, "website"?: string, "portfolio"?: string, "github"?: string },
  "experience"?: { "history"?: [{ "company"?: string, "title"?: string, "start"?: string, "end"?: string, "bullets"?: [string] }] },
  "education"?: [{ "degree"?: string, "institution"?: string, "years"?: string }],
  "logistics"?: { "workAuthorization"?: { "IL"?: boolean, "US"?: boolean, "EU"?: boolean }, "visaSponsorshipNeeded"?: boolean,
                  "relocation"?: "Yes"|"No"|"Depends", "noticePeriod"?: string },
  "compensation"?: { "salaryMax"?: number },
  "eeo"?: { "policy"?: "decline" },
  "delivery"?: { "method"?: string },
  "commonScreeningDefaults"?: { "howDidYouHear"?: string },
  "constraints"?: { "avoid"?: [string], "dealbreakers"?: [string], "salaryFloor"?: number, "commuteMax"?: number },
  "narrative"?: { "whatLookingForNow"?: string, "whyMovingNow"?: string, "motivation"?: string },
  "skills"?: { "hard"?: [{ "name": string, "evidence"?: string }], "soft"?: [string] },
  "evidence"?: [{ "role": string, "whyItFit"?: string, "sellingAngle"?: string, "skillsSurfaced"?: [string], "sourceType"?: "cv"|"interview"|"job"|"other" }],
  "differentiators"?: [string],
  "meta": { "strength": { "level": "weak"|"medium"|"strong", "score"?: number }, "examplesCount"?: integer, "conflicts"?: [string] }
}
\`\`\`
Required: schemaVersion, identity.location, identity.mobility, target.roles, meta.strength.level. Do not send userId/status (set server-side). Send only keys you actually have — omit empty ones, never send \`null\` or \`""\` (empty strings are dropped on ingest). \`remotePreference\` is expressed through \`identity.mobility\`; the salary floor is \`constraints.salaryFloor\` and the ceiling is \`compensation.salaryMax\`. Set \`meta.strength.level\` honestly: "weak" right after the CV, "medium" once roles+preferences+red-lines are confirmed, "strong" only when every period is a concrete evidence atom with outcomes AND the apply-critical logistics are known (work authorization, relocation, notice, contact email/phone, salary range); the page allows approval only at "strong".
`;

export async function createProfileFirstPilot(input: {
  userId: string; userName: string; template: string; baseUrl: string; agentBaseUrl: string;
  provisionToken: string; feedToken: string; fetchFn?: typeof fetch;
}): Promise<{ instructions: string; config: Record<string, string>; greeting: string }> {
  const base = new URL(input.baseUrl);
  const agentBase = new URL(input.agentBaseUrl);
  if (agentBase.protocol !== 'http:' || agentBase.hostname !== '172.17.0.1' || agentBase.port !== '18091'
      || agentBase.username || agentBase.password || agentBase.pathname !== '/' || agentBase.search || agentBase.hash) {
    throw new Error('Explicit private agent bridge URL required');
  }
  if (base.port === '8080' || !input.provisionToken || !/^\d+$/.test(input.userId) || !input.template.trim()) {
    throw new Error('Explicit central configuration and locked template required');
  }
  const boardToken = await mintScopedBoardToken(input.userId, input.feedToken, input.fetchFn);
  if (!boardToken) throw new Error('Profile-first registration failed: no scoped board token');
  const response = await (input.fetchFn || fetch)(new URL('/pilot-onboard', base), {
    method: 'POST', headers: { Authorization: `Bearer ${input.provisionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: input.userId, newRound: false, boardToken }), signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Profile-first registration failed (${response.status})`);
  const entry = await response.json() as {userId:string;agentToken:string;journey:string};
  if (entry.userId !== input.userId || !entry.agentToken || !entry.journey) throw new Error('Invalid profile-first registration');
  // The board link is deliberately NOT known at birth: the central service
  // returns boardUrl only in a successful PUT /interview/profile response
  // (revision >= 1), so the agent cannot share it before a profile exists.
  if (!boardToken) throw new Error('Profile-first registration failed: no scoped board token');
  const instructions = input.template.replaceAll('{{USER_NAME}}',input.userName).replaceAll('{{USER_ID}}',input.userId)
    .replaceAll('{{CENTRAL_BASE}}',input.agentBaseUrl) + PROFILE_FIRST_CONTRACT.replace('{{JOURNEY}}', entry.journey);
  return { instructions, greeting:entry.journey, config:{userId:input.userId,token:entry.agentToken,boardToken,baseUrl:input.agentBaseUrl} };
}

