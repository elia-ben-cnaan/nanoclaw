import { automaticWhatsAppGuard, registeredWhatsAppAccounts, requireWhatsAppAccount } from './whatsapp-agent-identities.js';
/** Host-owned identity registry. Never accept agent identity/hops from message text.
 * One external hop is the hard ceiling: WhatsApp does not preserve provenance.
 * A known agent account is stopped before interceptors, rate-limit replies or wake.
 */
import { createHash } from "node:crypto";
import type { InboundEvent } from "./channels/adapter.js";

export interface AgentAccount {
  phone: string;
  agents: string[];
}
export interface LoopPolicy {
  accounts: AgentAccount[];
  maxHops: 1;
  dedupMs: number;
}
export function phoneFromAddress(value: string): string | undefined {
  const cloud = /^whatsapp:\d+:(\d{7,15})$/.exec(value);
  const jid = /^(\d{7,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(value);
  const raw = /^\+?(\d{7,15})$/.exec(value);
  return (cloud ?? jid ?? raw)?.[1];
}
export function parseLoopPolicy(raw: string): LoopPolicy {
  const p = JSON.parse(raw);
  if (
    p.maxHops !== 1 ||
    !Number.isInteger(p.dedupMs) ||
    p.dedupMs < 1000 ||
    p.dedupMs > 300000 ||
    !Array.isArray(p.accounts) ||
    p.accounts.length === 0
  )
    throw new Error("Invalid WhatsApp loop policy");
  const seen = new Set<string>();
  for (const a of p.accounts) {
    const phone =
      typeof a.phone === "string" ? phoneFromAddress(a.phone) : undefined;
    if (
      !phone ||
      seen.has(phone) ||
      !Array.isArray(a.agents) ||
      !a.agents.length ||
      a.agents.some((id: unknown) => typeof id !== "string" || !id.trim())
    )
      throw new Error("Invalid agent account mapping");
    a.phone = phone;
    seen.add(phone);
  }
  return p;
}
// Runtime policy is derived exclusively from the automatic provider identity registry.
export function loopPolicy(): LoopPolicy | undefined {
  return automaticWhatsAppGuard() ? { accounts: registeredWhatsAppAccounts(), maxHops: 1, dedupMs: 60000 } : undefined;
}
export function owners(policy: LoopPolicy, address: string): string[] {
  const phone = phoneFromAddress(address);
  return policy.accounts.find((a) => a.phone === phone)?.agents ?? [];
}
export function exceedsHopLimit(hops: number, maximum: number): boolean {
  return !Number.isSafeInteger(hops) || hops < 0 || hops >= maximum;
}
/** Shared WhatsApp text normalization: NFKC, strip markdown emphasis, collapse
 * whitespace. Used by both the per-instance dedup and the cross-transport echo
 * guard so an outbound and its echoed inbound normalize to the same string. */
export function normalizeWhatsAppText(text: unknown): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export class WhatsAppLoopGuard {
  private recent = new Map<string, number>();
  constructor(private readonly now = Date.now) {}
  inspect(event: InboundEvent, policy: LoopPolicy): string | undefined {
    if (event.channelType !== "whatsapp") return;
    const body = JSON.parse(event.message.content);
    // Native Baileys and SDK bridge stamp these from provider identities.
    // Never use senderName/display name, content-provided originAgent or hop fields.
    const sender =
      phoneFromAddress(String(body.senderId ?? "")) ??
      phoneFromAddress(String(body.sender ?? "")) ??
      (!event.message.isGroup ? phoneFromAddress(event.platformId) : undefined);
    if (!sender || !owners(policy, sender).length) return;
    const now = this.now();
    for (const [key, until] of this.recent)
      if (until <= now) this.recent.delete(key);
    const normalized = normalizeWhatsAppText(body.text);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          sender,
          event.instance ?? event.channelType,
          event.platformId,
          normalized,
        ]),
      )
      .digest("hex");
    if (this.recent.has(key)) return "agent_content_duplicate";
    if (this.recent.size >= 10000)
      this.recent.delete(this.recent.keys().next().value!);
    this.recent.set(key, now + policy.dedupMs);
    // This hop count is derived by the host, never trusted from external payloads.
    // No known-agent inbound is allowed to wake a second agent (including self echoes).
    if (exceedsHopLimit(1, policy.maxHops)) return "agent_external_max_hops";
    return "agent_external_source"; // defense if the policy type changes in future
  }
}
export const whatsappLoopGuard = new WhatsAppLoopGuard();

/**
 * Cross-transport echo guard.
 *
 * When one phone number is bound to BOTH WhatsApp transports at once — native
 * Baileys (`instance: 'whatsapp'`) and the Cloud API pilot (`instance: <cloud>`)
 * — a reply the agent sends on one transport is redelivered as an inbound on the
 * sibling transport, and the agent answers it, forever. `WhatsAppLoopGuard`
 * cannot see this: its dedup key includes `event.instance`, so the same text on
 * a different transport hashes to a different key and is treated as fresh.
 *
 * This guard is transport-agnostic. Every outbound WhatsApp reply is
 * fingerprinted by its normalized text into a short-lived, size-capped TTL map
 * at the shared delivery choke point (src/delivery.ts). On every WhatsApp
 * inbound we drop the message when BOTH hold: the sender is one of OUR OWN
 * mapped agent numbers (on any transport), and its normalized text matches a
 * still-live outbound fingerprint. A Baileys outbound is therefore caught when
 * it returns as a Cloud-API inbound and vice versa.
 *
 * It is active only while `loopPolicy()` is defined, i.e. only when
 * `WHATSAPP_LOOP_GUARD=1` (see `automaticWhatsAppGuard`). With the env unset the
 * store is never written or read and behavior is byte-identical to before.
 */
export class WhatsAppEchoGuard {
  private recent = new Map<string, number>();
  constructor(
    private readonly now = Date.now,
    private readonly ttlMs = 60000,
    private readonly cap = 5000,
  ) {}
  private purge(now: number): void {
    for (const [key, until] of this.recent)
      if (until <= now) this.recent.delete(key);
  }
  /** Fingerprint an outbound reply. Caller gates on loopPolicy()/channelType. */
  recordOutbound(text: unknown): void {
    const normalized = normalizeWhatsAppText(text);
    if (!normalized) return;
    const now = this.now();
    this.purge(now);
    this.recent.delete(normalized); // refresh: move to newest slot before cap check
    if (this.recent.size >= this.cap)
      this.recent.delete(this.recent.keys().next().value!);
    this.recent.set(normalized, now + this.ttlMs);
  }
  /** Returns a block reason when the inbound is our own outbound echoing back
   * from the sibling transport, otherwise undefined. */
  inspectInbound(event: InboundEvent, policy: LoopPolicy): string | undefined {
    if (event.channelType !== "whatsapp") return;
    let body: { text?: unknown; sender?: unknown; senderId?: unknown };
    try {
      body = JSON.parse(event.message.content);
    } catch {
      return;
    }
    const sender =
      phoneFromAddress(String(body.senderId ?? "")) ??
      phoneFromAddress(String(body.sender ?? "")) ??
      (!event.message.isGroup ? phoneFromAddress(event.platformId) : undefined);
    // Only our own mapped numbers can echo; a real user's inbound never does.
    if (!sender || !owners(policy, sender).length) return;
    const normalized = normalizeWhatsAppText(body.text);
    if (!normalized) return;
    const now = this.now();
    this.purge(now);
    const until = this.recent.get(normalized);
    if (until !== undefined && until > now) return "agent_cross_transport_echo";
    return;
  }
}
export const whatsappEchoGuard = new WhatsAppEchoGuard();

/**
 * Record an outbound WhatsApp reply's fingerprint for the cross-transport echo
 * guard. Called from the shared delivery choke point for every delivery; a
 * no-op for non-WhatsApp channels and whenever the loop guard is disabled
 * (WHATSAPP_LOOP_GUARD unset). Never throws — the delivery hot path must not be
 * affected by guard bookkeeping.
 */
export function recordWhatsAppOutbound(
  channelType: string,
  content: string,
): void {
  try {
    if (channelType !== "whatsapp") return;
    if (!loopPolicy()) return;
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === "string")
      whatsappEchoGuard.recordOutbound(parsed.text);
  } catch {
    /* defensive: never let echo bookkeeping break delivery */
  }
}

export interface RouteEdge {
  from: string;
  to: string;
  external: boolean;
}
/** Reject only cycles containing an external WhatsApp edge; internal cooperation is unchanged. */
export function assertNoExternalCycle(
  edges: RouteEdge[],
  candidates = edges,
): void {
  const adjacency = new Map<string, RouteEdge[]>();
  for (const e of edges)
    adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e]);
  for (const edge of candidates) {
    const pending = [{ node: edge.to, external: edge.external }],
      visited = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next.node === edge.from && next.external)
        throw new Error("WhatsApp agent routing cycle blocked");
      const key = JSON.stringify([next.node, next.external]);
      if (visited.has(key)) continue;
      visited.add(key);
      for (const e of adjacency.get(next.node) ?? [])
        pending.push({ node: e.to, external: next.external || e.external });
    }
  }
}

/** Shared earliest-ingress gate; intentionally sends no acknowledgement on rejection. */
export function whatsappInboundBlockReason(
  event: InboundEvent,
): string | undefined {
  if (event.channelType !== "whatsapp") return;
  requireWhatsAppAccount(event.instance ?? event.channelType);
  const policy = loopPolicy();
  if (!policy) return undefined;
  // Cross-transport echo takes precedence over per-instance dedup: this is our
  // own outbound returning on the sibling transport, which dedup cannot see.
  return (
    whatsappEchoGuard.inspectInbound(event, policy) ??
    whatsappLoopGuard.inspect(event, policy)
  );
}
