/**
 * Users Board — qualitative layer (topics, day-by-day summaries, insights).
 *
 * This is the part Elia actually asked for: not "who is this person" but
 * "what have we been talking about, and what does it tell us". Generation
 * is explicit and cached — never triggered by a page load — because it
 * calls Claude Haiku per user/day and that cost should be predictable, not
 * proportional to how often someone refreshes the board.
 *
 * Caching: each cache row carries a content_hash of its source messages.
 * A refresh only regenerates rows whose source content changed since the
 * last run — a quiet pilot costs nothing on repeat refreshes.
 *
 * Credentials: resolved the same way the rest of the host resolves env
 * (readEnvFile + process.env). If no ANTHROPIC_API_KEY is configured, every
 * call degrades to a deterministic, non-fabricated fallback (real quotes,
 * counts, distilled text) and a single warning is logged per refresh run —
 * the qualitative layer never crashes or blocks Layer 1/2.
 */
import crypto from 'crypto';

import { getDb } from './db/connection.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import {
  collectDailyTranscript,
  distillLastText,
  type DayTranscript,
  type TranscriptMessage,
} from './users-board-data.js';

// ─── credentials + raw call ──────────────────────────────────────────────────

const HAIKU_MODEL = 'claude-haiku-4-5';

function resolveApiKey(): string | null {
  const fromEnv = readEnvFile(['ANTHROPIC_API_KEY']);
  return fromEnv['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_API_KEY'] || null;
}

let warnedNoKeyThisRun = false;

/**
 * One Messages API call, JSON-schema-constrained output. Returns null on any
 * failure (no key, network error, refusal, bad JSON) — callers must have a
 * deterministic fallback and must never fabricate data on a null return.
 */
async function callHaikuJson<T>(
  system: string,
  userPrompt: string,
  schema: Record<string, unknown>,
): Promise<T | null> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    if (!warnedNoKeyThisRun) {
      log.warn(
        'users-board: ANTHROPIC_API_KEY not configured — qualitative summaries will use deterministic fallback only',
      );
      warnedNoKeyThisRun = true;
    }
    return null;
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userPrompt }],
        output_config: { format: { type: 'json_schema', schema } },
      }),
    });
    if (!res.ok) {
      log.warn('users-board: haiku call failed', { status: res.status, body: (await res.text()).slice(0, 300) });
      return null;
    }
    const body = (await res.json()) as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    if (body.stop_reason === 'refusal') return null;
    const text = body.content?.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (err) {
    log.warn('users-board: haiku call errored', { err });
    return null;
  }
}

// ─── content hashing ──────────────────────────────────────────────────────────

function hashMessages(messages: TranscriptMessage[]): string {
  const h = crypto.createHash('sha256');
  for (const m of messages) h.update(m.role + '|' + m.text + '|');
  return h.digest('hex').slice(0, 16);
}

function hashAll(days: DayTranscript[]): string {
  return hashMessages(days.flatMap((d) => d.messages));
}

// ─── deterministic fallbacks (no LLM required) ────────────────────────────────

function fallbackDaySummary(day: DayTranscript): string {
  const userMsgs = day.messages.filter((m) => m.role === 'user');
  if (userMsgs.length === 0) return 'הסוכן שלח הודעה, המשתמש לא הגיב.';
  const gists = userMsgs
    .slice(0, 3)
    .map((m) => distillLastText(m.text, 40))
    .filter((g): g is string => Boolean(g));
  const uniq = [...new Set(gists)];
  return `${userMsgs.length} הודעות. ${uniq.length ? 'בין הנושאים: ' + uniq.join(', ') : ''}`.trim();
}

function fallbackTopic(days: DayTranscript[]): string {
  const firstDay = days.find((d) => d.messages.some((m) => m.role === 'user'));
  const firstUserMsg = firstDay?.messages.find((m) => m.role === 'user');
  const gist = firstUserMsg ? distillLastText(firstUserMsg.text, 70) : null;
  return gist ? `פנה בעניין: ${gist}` : 'עדיין אין מספיק תוכן לזיהוי נושא.';
}

// ─── schemas ───────────────────────────────────────────────────────────────────

const DAY_SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

export interface UserInsights {
  topic: string;
  whatWorks: string | null;
  whatsStuck: string | null;
  satisfaction: 'positive' | 'neutral' | 'negative' | 'unknown';
  referralMoment: string | null;
  qualityFlags: string[];
}

const USER_INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'One sentence: what this person uses the agent for.' },
    whatWorks: { type: ['string', 'null'], description: 'One sentence on what is going well, or null.' },
    whatsStuck: { type: ['string', 'null'], description: 'One sentence on an open/stuck thread, or null.' },
    satisfaction: { type: 'string', enum: ['positive', 'neutral', 'negative', 'unknown'] },
    referralMoment: {
      type: ['string', 'null'],
      description: 'One sentence if there was a UGC/referral-worthy moment, else null.',
    },
    qualityFlags: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Short Hebrew tags for real quality problems observed in the AGENT's own replies only — garbled/broken Hebrew, wrong gender agreement, factual contradiction, repeated/looping replies. Empty array if none.",
    },
  },
  required: ['topic', 'whatWorks', 'whatsStuck', 'satisfaction', 'referralMoment', 'qualityFlags'],
  additionalProperties: false,
};

export interface AggregateInsights {
  recurringThemes: string[];
  commonUseCases: string[];
  recurringProblems: string[];
}

const AGGREGATE_SCHEMA = {
  type: 'object',
  properties: {
    recurringThemes: { type: 'array', items: { type: 'string' } },
    commonUseCases: { type: 'array', items: { type: 'string' } },
    recurringProblems: { type: 'array', items: { type: 'string' } },
  },
  required: ['recurringThemes', 'commonUseCases', 'recurringProblems'],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  'You are a product analyst reviewing WhatsApp conversations between a personal AI assistant pilot and its users. ' +
  'Respond only in Hebrew, only with the requested JSON. Be concrete and grounded in what was actually said — never invent facts, names, or events not present in the transcript. If there is not enough information for a field, use null or an empty string/array as the schema allows. Keep every field to one short sentence unless it is a list.';

function transcriptBlock(messages: TranscriptMessage[]): string {
  return messages.map((m) => `[${m.role === 'user' ? 'משתמש' : 'סוכן'}] ${m.text}`).join('\n');
}

// ─── cache reads (used by the board — never generate on read) ────────────────

export interface CachedDaySummary {
  day: string;
  summary: string;
  generatedAt: string | null;
  fromCache: boolean;
}

export function getCachedDaySummaries(agentGroupId: string, days: DayTranscript[]): CachedDaySummary[] {
  const rows = getDb()
    .prepare('SELECT day, content_hash, summary, generated_at FROM day_summaries WHERE agent_group_id = ?')
    .all(agentGroupId) as Array<{ day: string; content_hash: string; summary: string; generated_at: string }>;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((d) => {
    const cached = byDay.get(d.day);
    const hash = hashMessages(d.messages);
    if (cached && cached.content_hash === hash) {
      return { day: d.day, summary: cached.summary, generatedAt: cached.generated_at, fromCache: true };
    }
    return { day: d.day, summary: fallbackDaySummary(d), generatedAt: null, fromCache: false };
  });
}

export function getCachedUserInsights(
  agentGroupId: string,
  days: DayTranscript[],
): UserInsights & { generatedAt: string | null; fromCache: boolean } {
  const row = getDb()
    .prepare('SELECT content_hash, topic, insights_json, generated_at FROM user_insights WHERE agent_group_id = ?')
    .get(agentGroupId) as
    | { content_hash: string; topic: string | null; insights_json: string; generated_at: string }
    | undefined;
  const hash = hashAll(days);
  if (row && row.content_hash === hash) {
    try {
      const parsed = JSON.parse(row.insights_json) as UserInsights;
      return { ...parsed, generatedAt: row.generated_at, fromCache: true };
    } catch {
      /* fall through to fallback */
    }
  }
  return {
    topic: fallbackTopic(days),
    whatWorks: null,
    whatsStuck: null,
    satisfaction: 'unknown',
    referralMoment: null,
    qualityFlags: [],
    generatedAt: null,
    fromCache: false,
  };
}

/** Cheap read: cached one-line topics for every pilot that has one, keyed by agent_group_id. No generation. */
export function getCachedTopics(): Map<string, string> {
  const rows = getDb()
    .prepare('SELECT agent_group_id, topic FROM user_insights WHERE topic IS NOT NULL')
    .all() as Array<{
    agent_group_id: string;
    topic: string;
  }>;
  return new Map(rows.map((r) => [r.agent_group_id, r.topic]));
}

export function getCachedAggregate(): (AggregateInsights & { generatedAt: string | null }) | null {
  const row = getDb().prepare('SELECT insights_json, generated_at FROM board_aggregate WHERE id = 1').get() as
    | { insights_json: string; generated_at: string }
    | undefined;
  if (!row) return null;
  try {
    return { ...(JSON.parse(row.insights_json) as AggregateInsights), generatedAt: row.generated_at };
  } catch {
    return null;
  }
}

// ─── refresh (generation) ─────────────────────────────────────────────────────

export interface RefreshResult {
  usersProcessed: number;
  daysGenerated: number;
  daysSkippedCached: number;
  usersSkippedCached: number;
  aggregateGenerated: boolean;
  hadApiKey: boolean;
}

/** Regenerate stale day summaries + the user-level insight for one pilot. Returns per-user stats. */
async function refreshOneUser(
  agentGroupId: string,
): Promise<{ daysGenerated: number; daysSkipped: number; userSkipped: boolean }> {
  const days = collectDailyTranscript(agentGroupId);
  const db = getDb();
  let daysGenerated = 0;
  let daysSkipped = 0;

  const existingDayHashes = new Map(
    (
      db.prepare('SELECT day, content_hash FROM day_summaries WHERE agent_group_id = ?').all(agentGroupId) as Array<{
        day: string;
        content_hash: string;
      }>
    ).map((r) => [r.day, r.content_hash]),
  );

  for (const day of days) {
    if (day.messages.every((m) => m.role !== 'user')) continue; // nothing a user said — skip entirely
    const hash = hashMessages(day.messages);
    if (existingDayHashes.get(day.day) === hash) {
      daysSkipped++;
      continue;
    }
    const result = await callHaikuJson<{ summary: string }>(
      SYSTEM_PROMPT,
      `Summarize this ONE DAY of conversation in 1-2 short Hebrew sentences: what did the user ask about, what did the agent do. Day: ${day.day}\n\n${transcriptBlock(day.messages)}`,
      DAY_SUMMARY_SCHEMA,
    );
    const summary = result?.summary?.trim() || fallbackDaySummary(day);
    db.prepare(
      `INSERT INTO day_summaries (agent_group_id, day, content_hash, summary, generated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id, day) DO UPDATE SET content_hash=excluded.content_hash, summary=excluded.summary, generated_at=excluded.generated_at`,
    ).run(agentGroupId, day.day, hash, summary, new Date().toISOString());
    daysGenerated++;
  }

  const totalHash = hashAll(days);
  const existingUser = db
    .prepare('SELECT content_hash FROM user_insights WHERE agent_group_id = ?')
    .get(agentGroupId) as { content_hash: string } | undefined;
  let userSkipped = false;
  if (existingUser?.content_hash === totalHash) {
    userSkipped = true;
  } else if (days.some((d) => d.messages.some((m) => m.role === 'user'))) {
    const allText = transcriptBlock(days.flatMap((d) => d.messages)).slice(0, 12_000); // cost guard
    const result = await callHaikuJson<UserInsights>(
      SYSTEM_PROMPT,
      `Review this pilot user's full conversation history and produce insights for the operator.\n\n${allText}`,
      USER_INSIGHTS_SCHEMA,
    );
    const insights: UserInsights = result ?? {
      topic: fallbackTopic(days),
      whatWorks: null,
      whatsStuck: null,
      satisfaction: 'unknown',
      referralMoment: null,
      qualityFlags: [],
    };
    db.prepare(
      `INSERT INTO user_insights (agent_group_id, content_hash, topic, insights_json, generated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET content_hash=excluded.content_hash, topic=excluded.topic, insights_json=excluded.insights_json, generated_at=excluded.generated_at`,
    ).run(agentGroupId, totalHash, insights.topic, JSON.stringify(insights), new Date().toISOString());
  }

  return { daysGenerated, daysSkipped, userSkipped };
}

/**
 * Full refresh: every live pilot's day summaries + user insights, then a
 * cross-user aggregate. Safe to call repeatedly — unchanged content is
 * skipped via content-hash comparison, so a no-op refresh costs one Haiku
 * call (the aggregate) at most.
 */
export async function refreshAllSummaries(): Promise<RefreshResult> {
  warnedNoKeyThisRun = false;
  const hadApiKey = resolveApiKey() !== null;
  const groups = getDb()
    .prepare(`SELECT id FROM agent_groups WHERE folder LIKE 'pilot-%' OR folder LIKE 'whatsapp-%'`)
    .all() as Array<{ id: string }>;

  let daysGenerated = 0;
  let daysSkippedCached = 0;
  let usersSkippedCached = 0;
  for (const g of groups) {
    const r = await refreshOneUser(g.id);
    daysGenerated += r.daysGenerated;
    daysSkippedCached += r.daysSkipped;
    if (r.userSkipped) usersSkippedCached++;
  }

  // Aggregate: built from each user's cached topic + insights (cheap — no transcripts).
  const userRows = getDb().prepare('SELECT topic, insights_json FROM user_insights').all() as Array<{
    topic: string | null;
    insights_json: string;
  }>;
  let aggregateGenerated = false;
  if (userRows.length >= 2) {
    const summaryHash = crypto
      .createHash('sha256')
      .update(userRows.map((r) => r.topic + '|' + r.insights_json).join('~'))
      .digest('hex')
      .slice(0, 16);
    const existing = getDb().prepare('SELECT content_hash FROM board_aggregate WHERE id = 1').get() as
      | { content_hash: string }
      | undefined;
    if (existing?.content_hash !== summaryHash) {
      const input = userRows.map((r, i) => `משתמש ${i + 1}: ${r.topic}\n${r.insights_json}`).join('\n\n');
      const result = await callHaikuJson<AggregateInsights>(
        SYSTEM_PROMPT,
        `Across ALL these pilot users, identify recurring themes. Input (one block per user):\n\n${input}`,
        AGGREGATE_SCHEMA,
      );
      if (result) {
        getDb()
          .prepare(
            `INSERT INTO board_aggregate (id, content_hash, insights_json, generated_at) VALUES (1, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash, insights_json=excluded.insights_json, generated_at=excluded.generated_at`,
          )
          .run(summaryHash, JSON.stringify(result), new Date().toISOString());
        aggregateGenerated = true;
      }
    }
  }

  return {
    usersProcessed: groups.length,
    daysGenerated,
    daysSkippedCached,
    usersSkippedCached,
    aggregateGenerated,
    hadApiKey,
  };
}
