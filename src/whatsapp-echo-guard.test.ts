import { describe, it, expect } from 'vitest';
import { WhatsAppEchoGuard, type LoopPolicy } from './whatsapp-loop-guard.js';
import type { InboundEvent } from './channels/adapter.js';

// Number 972547872636 is (mis)mapped to both transports; it is one of OUR
// agent accounts, so an inbound "from" it repeating a recent outbound is an echo.
const OUR_NUMBER = '972547872636';
const policy: LoopPolicy = {
  accounts: [{ phone: OUR_NUMBER, agents: ['joni'] }],
  maxHops: 1,
  dedupMs: 60000,
};

// Cloud-API inbound shape: sender carried in the JSON body.
function cloudInbound(text: string, from = OUR_NUMBER): InboundEvent {
  return {
    channelType: 'whatsapp',
    instance: 'whatsapp-cloud',
    platformId: `whatsapp:100:${from}`,
    threadId: null,
    message: { id: 'm1', kind: 'chat', timestamp: '', content: JSON.stringify({ text, sender: from }) },
  };
}

// Baileys (native) inbound shape: sender carried as a JID in platformId, no
// body.sender. Proves the OTHER echo direction (Cloud outbound returns on Baileys).
function baileysInbound(text: string, from = OUR_NUMBER): InboundEvent {
  return {
    channelType: "whatsapp",
    instance: "whatsapp",
    platformId: from + "@s.whatsapp.net",
    threadId: null,
    message: { id: "b1", kind: "chat", timestamp: "", content: JSON.stringify({ text }) },
  };
}

describe('WhatsAppEchoGuard (cross-transport)', () => {
  it('drops a Baileys outbound that returns as a Cloud-API inbound', () => {
    const g = new WhatsAppEchoGuard();
    g.recordOutbound('Hi there — how can I help?'); // sent on Baileys
    // Same text arrives on the *other* transport, from our own number.
    expect(g.inspectInbound(cloudInbound('Hi there — how can I help?'), policy))
      .toBe('agent_cross_transport_echo');
  });

  it('normalizes markdown/whitespace so an echo still matches', () => {
    const g = new WhatsAppEchoGuard();
    g.recordOutbound('*Hello*   world');
    expect(g.inspectInbound(cloudInbound('Hello world'), policy))
      .toBe('agent_cross_transport_echo');
  });

  it('does not block a genuine inbound from a real user (not our number)', () => {
    const g = new WhatsAppEchoGuard();
    g.recordOutbound('Hi there');
    expect(g.inspectInbound(cloudInbound('Hi there', '972500000001'), policy))
      .toBeUndefined();
  });

  it('does not block a different message from our number', () => {
    const g = new WhatsAppEchoGuard();
    g.recordOutbound('Hi there');
    expect(g.inspectInbound(cloudInbound('unrelated question'), policy))
      .toBeUndefined();
  });

  it('expires fingerprints after the TTL', () => {
    let t = 1000;
    const g = new WhatsAppEchoGuard(() => t, 30000);
    g.recordOutbound('ephemeral');
    t = 1000 + 30001; // past TTL
    expect(g.inspectInbound(cloudInbound('ephemeral'), policy)).toBeUndefined();
  });

  it('caps the store size', () => {
    let t = 0;
    const g = new WhatsAppEchoGuard(() => ++t, 30000, 3);
    for (let i = 0; i < 10; i++) g.recordOutbound(`msg-${i}`);
    // Oldest evicted; the most recent still matches.
    expect(g.inspectInbound(cloudInbound('msg-9'), policy)).toBe('agent_cross_transport_echo');
    expect(g.inspectInbound(cloudInbound('msg-0'), policy)).toBeUndefined();
  });

  it("drops a Cloud-API outbound that returns as a Baileys inbound (JID sender)", () => {
    const g = new WhatsAppEchoGuard();
    g.recordOutbound("Ready to help you today?"); // sent on Cloud API
    expect(g.inspectInbound(baileysInbound("Ready to help you today?"), policy))
      .toBe("agent_cross_transport_echo");
  });

  it("does not block a Baileys inbound from a real user JID", () => {
    const g = new WhatsAppEchoGuard();
    g.recordOutbound("Ready to help you today?");
    expect(g.inspectInbound(baileysInbound("Ready to help you today?", "972500000001"), policy))
      .toBeUndefined();
  });

  it("does not treat a group-thread inbound as an echo", () => {
    const g = new WhatsAppEchoGuard();
    g.recordOutbound("group blast");
    const ev = baileysInbound("group blast");
    ev.message.isGroup = true; // group sender must not resolve to an owner via platformId
    expect(g.inspectInbound(ev, policy)).toBeUndefined();
  });

  it("keeps a re-recorded fingerprint alive under cap pressure", () => {
    let t = 0;
    const g = new WhatsAppEchoGuard(() => ++t, 30000, 3);
    g.recordOutbound("hot");
    g.recordOutbound("a");
    g.recordOutbound("hot"); // refresh -> newest slot
    g.recordOutbound("b");
    g.recordOutbound("c"); // cap=3 eviction; refreshed "hot" must survive
    expect(g.inspectInbound(cloudInbound("hot"), policy)).toBe("agent_cross_transport_echo");
  });

});
