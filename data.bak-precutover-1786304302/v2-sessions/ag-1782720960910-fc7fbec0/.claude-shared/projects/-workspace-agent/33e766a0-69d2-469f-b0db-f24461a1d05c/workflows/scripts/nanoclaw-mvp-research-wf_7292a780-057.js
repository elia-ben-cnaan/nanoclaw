export const meta = {
  name: 'nanoclaw-mvp-research',
  description: 'Research 10 MVP issues for multi-tenant NanoClaw agents',
  phases: [
    { title: 'Research', detail: 'Investigate each issue for existing solutions' },
    { title: 'Synthesis', detail: 'Consolidate findings + identify gaps' },
  ],
}

const ISSUES = [
  { id: 1, title: 'Dedup users', detail: 'Same person registers twice → new agent/chat. Detect existing via phone or Telegram chat ID.' },
  { id: 2, title: 'Triple messages', detail: 'Each inbound → 3 responses (idempotency/outbound dedup).' },
  { id: 3, title: 'Cost ceiling', detail: 'Not enforced. Burned 8.5M tokens vs budget. Need enforcement + daily reset.' },
  { id: 4, title: 'Orphan agents', detail: 'Registered but never clicked START. Cleanup.' },
  { id: 5, title: 'Pairing code expiry', detail: 'No expiry or single-use enforcement.' },
  { id: 6, title: 'Input validation', detail: 'Email/phone on signup unvalidated.' },
  { id: 7, title: 'Silent failures', detail: 'Tunnel/API down → no error message.' },
  { id: 8, title: 'Agent hijack', detail: 'Lock agent to first chat (prevent takeover).' },
  { id: 9, title: 'Rate limits', detail: 'No per-chat flood protection.' },
  { id: 10, title: 'External API key', detail: 'Let users add their own Anthropic key (secure, one-time link to email, not in chat).' },
]

phase('Research')
const findings = await Promise.all(ISSUES.map(issue =>
  agent(
    `Research issue #${issue.id}: **${issue.title}**\n\n${issue.detail}\n\nFind: (a) existing solution in NanoClaw/Claude Agent SDK/OneCLI or GitHub; (b) why it matters; (c) effort (line/day/week); (d) confidence (high/medium/low). Format as structured JSON with keys: solution, why, effort, confidence, link.`,
    {
      label: `research:${issue.id}-${issue.title.replace(/ /g, '-')}`,
      phase: 'Research',
      schema: {
        type: 'object',
        properties: {
          issue_id: { type: 'number' },
          solution: { type: 'string', description: 'Existing solution name/link or "build from scratch"' },
          why: { type: 'string', description: 'Why this matters for MVP' },
          effort: { type: 'string', enum: ['line', 'day', 'week'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          link: { type: 'string', description: 'GitHub/docs URL or empty string' },
          notes: { type: 'string', description: 'Any caveats or alternatives' },
        },
        required: ['issue_id', 'solution', 'why', 'effort', 'confidence']
      }
    }
  )
))

log(`Researched ${findings.filter(Boolean).length}/${ISSUES.length} issues`)

phase('Synthesis')
const synthesis = await agent(
  `You researched 10 MVP issues for multi-tenant NanoClaw agents. Here are the findings:\n\n${findings.filter(Boolean).map(f => `#${f.issue_id} (${f.solution}): effort=${f.effort}, confidence=${f.confidence}`).join('\n')}\n\nNow:\n1. Identify 3–5 things NOT on the list that matter for a hosted multi-tenant agent platform (security, abuse, scale, monitoring, privacy, compliance).\n2. Decide: what's the absolute MVP minimum? What can defer to round 2?\n3. Score each issue (high/medium/low priority for MVP).\n\nReturn as JSON: { gaps: [...], mvp_deferral: {...}, priorities: [...] }`,
  {
    label: 'synthesis',
    phase: 'Synthesis',
    schema: {
      type: 'object',
      properties: {
        gaps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              why: { type: 'string' },
              examples: { type: 'string' }
            }
          },
          description: 'Things not on the original list'
        },
        priorities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issue_id: { type: 'number' },
              title: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              reason: { type: 'string' }
            }
          }
        },
        mvp_deferral: {
          type: 'object',
          properties: {
            include: { type: 'array', items: { type: 'number' }, description: 'Issue IDs in MVP' },
            defer_round2: { type: 'array', items: { type: 'number' }, description: 'Issue IDs for round 2' },
            reasoning: { type: 'string' }
          }
        }
      },
      required: ['gaps', 'priorities', 'mvp_deferral']
    }
  }
)

return {
  issues_researched: findings.filter(Boolean).length,
  findings: findings.filter(Boolean),
  gaps: synthesis?.gaps || [],
  priorities: synthesis?.priorities || [],
  mvp_plan: synthesis?.mvp_deferral || {},
}