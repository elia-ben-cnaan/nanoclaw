/**
 * Users Board — per-user detail assembly.
 *
 * Combines: real transcript (quotes, per-day message counts) from
 * users-board-data, and cached qualitative summaries from
 * users-board-summarize. Read-only — never triggers generation; a page
 * open always renders instantly from whatever is cached (or the
 * deterministic fallback if nothing has been generated yet).
 */
import { getActivationByAgentGroup } from './modules/pilot-activation/db.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { collectDailyTranscript, distillLastText, type TranscriptMessage } from './users-board-data.js';
import { getCachedDaySummaries, getCachedUserInsights, type CachedDaySummary } from './users-board-summarize.js';

export interface Quote {
  text: string;
  ms: number;
}

export interface DetailDay extends CachedDaySummary {
  userMessageCount: number;
  agentMessageCount: number;
}

export interface UserDetail {
  slug: string;
  name: string | null;
  topic: string;
  whatWorks: string | null;
  whatsStuck: string | null;
  satisfaction: 'positive' | 'neutral' | 'negative' | 'unknown';
  referralMoment: string | null;
  qualityFlags: string[];
  insightsGeneratedAt: string | null;
  insightsFromCache: boolean;
  days: DetailDay[];
  quotes: Quote[];
  totalUserMessages: number;
}

/** Pick up to N representative real user quotes: longest messages, spread across days, deduped. */
function pickQuotes(allMessages: TranscriptMessage[], n: number): Quote[] {
  const userMsgs = allMessages.filter((m) => m.role === 'user' && m.text.trim().length >= 8);
  const seen = new Set<string>();
  const ranked = [...userMsgs].sort((a, b) => b.text.length - a.text.length);
  const picked: Quote[] = [];
  for (const m of ranked) {
    const key = m.text.trim().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ text: m.text.trim().slice(0, 240), ms: m.ms });
    if (picked.length >= n) break;
  }
  return picked.sort((a, b) => a.ms - b.ms);
}

export function buildUserDetail(folder: string): UserDetail | null {
  const ag = getAgentGroupByFolder(folder);
  if (!ag) return null;

  let name: string | null = null;
  try {
    const activation = getActivationByAgentGroup(ag.id);
    const meta = activation?.metadata ? (JSON.parse(activation.metadata) as Record<string, unknown>) : null;
    name = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : null;
  } catch {
    /* no registration info — fine, board still works with the slug */
  }

  const days = collectDailyTranscript(ag.id);
  const summaries = getCachedDaySummaries(ag.id, days);
  const insights = getCachedUserInsights(ag.id, days);

  const detailDays: DetailDay[] = days.map((d, i) => ({
    ...summaries[i],
    userMessageCount: d.messages.filter((m) => m.role === 'user').length,
    agentMessageCount: d.messages.filter((m) => m.role === 'agent').length,
  }));

  const allMessages = days.flatMap((d) => d.messages);
  const quotes = pickQuotes(allMessages, 5);

  return {
    slug: folder,
    name,
    topic:
      insights.topic ||
      distillLastText(allMessages.find((m) => m.role === 'user')?.text ?? null, 80) ||
      'אין עדיין מספיק תוכן',
    whatWorks: insights.whatWorks,
    whatsStuck: insights.whatsStuck,
    satisfaction: insights.satisfaction,
    referralMoment: insights.referralMoment,
    qualityFlags: insights.qualityFlags,
    insightsGeneratedAt: insights.generatedAt,
    insightsFromCache: insights.fromCache,
    days: detailDays,
    quotes,
    totalUserMessages: allMessages.filter((m) => m.role === 'user').length,
  };
}
