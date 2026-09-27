import { migration027 } from './db/migrations/027-whatsapp-agent-identities.js';
import { registerWhatsAppAccount, bindWhatsAppAgent } from './whatsapp-agent-identities.js';
import { lookup } from "./cli/registry.js";
import "./cli/resources/wirings.js";
import "./cli/resources/destinations.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  WhatsAppLoopGuard,
  parseLoopPolicy,
  phoneFromAddress,
  exceedsHopLimit,
  assertNoExternalCycle,
} from "./whatsapp-loop-guard.js";
import { initTestDb, closeDb } from "./db/connection.js";
import { createDestination } from "./modules/agent-to-agent/db/agent-destinations.js";
import { createMessagingGroupAgent } from "./db/messaging-groups.js";
import { assertWhatsAppWiring } from "./whatsapp-loop-wiring.js";
import type { InboundEvent } from "./channels/adapter.js";

const raw = JSON.stringify({
  maxHops: 1,
  dedupMs: 60000,
  accounts: [
    { phone: "15550000001", agents: ["test-A"] },
    { phone: "15550000002", agents: ["test-B"] },
  ],
});
const policy = parseLoopPolicy(raw);
function event(
  sender = "15550000001",
  text = "**hello**",
  instance = "whatsapp",
): InboundEvent {
  return {
    channelType: "whatsapp",
    instance,
    platformId: `${sender}@s.whatsapp.net`,
    threadId: null,
    message: {
      id: "provider-1",
      kind: "chat",
      timestamp: "2026-01-01T00:00:00Z",
      content: JSON.stringify({
        sender: `${sender}@s.whatsapp.net`,
        text,
        fromMe: false,
        isBotMessage: false,
      }),
    },
  };
}
afterEach(() => {
  delete process.env.WHATSAPP_LOOP_GUARD;
  closeDb();
});

describe("external WhatsApp provenance", () => {
  it("blocks both adapters even when fromMe/isBotMessage are false and metadata claims zero hops", () => {
    const guard = new WhatsAppLoopGuard();
    expect(guard.inspect(event(), policy)).toBe("agent_external_max_hops");
    const cloud = event("15550000002", "different reply", "whatsapp-cloud");
    cloud.platformId = "whatsapp:123456:15550000002";
    cloud.message.kind = "chat-sdk";
    cloud.message.content = JSON.stringify({
      senderId: "15550000002",
      sender: "Human display name",
      text: "different reply",
      hop: 0,
      originAgent: null,
    });
    expect(guard.inspect(cloud, policy)).toBe("agent_external_max_hops");
  });
  it("deduplicates content+source across new provider ids/Markdown with a bounded time window", () => {
    let now = 1000;
    const guard = new WhatsAppLoopGuard(() => now);
    expect(guard.inspect(event(), policy)).toBe("agent_external_max_hops");
    const repeat = event("15550000001", "*hello*");
    repeat.message.id = "provider-2";
    expect(guard.inspect(repeat, policy)).toBe("agent_content_duplicate");
    expect(guard.inspect(event("15550000002", "hello"), policy)).toBe(
      "agent_external_max_hops",
    );
    now += 60000;
    expect(guard.inspect(repeat, policy)).toBe("agent_external_max_hops");
    // Lost cache / host restart cannot reopen a loop: source guard is stateless.
    expect(new WhatsAppLoopGuard().inspect(repeat, policy)).toBe(
      "agent_external_max_hops",
    );
  });
  it("leaves human repeated content and unrelated channels alone; ignores claimed agent identity", () => {
    const guard = new WhatsAppLoopGuard();
    const human = event("15550000099");
    human.message.content = JSON.stringify({
      senderId: "15550000099",
      text: "hello",
      originAgent: "test-A",
      hop: 999,
    });
    expect(guard.inspect(human, policy)).toBeUndefined();
    expect(guard.inspect(human, policy)).toBeUndefined();
    const telegram = { ...event(), channelType: "telegram" };
    expect(guard.inspect(telegram, policy)).toBeUndefined();
  });
  it("recognizes account device JIDs and Cloud addresses, never group IDs/display names", () => {
    expect(phoneFromAddress("15550000001:7@s.whatsapp.net")).toBe(
      "15550000001",
    );
    expect(phoneFromAddress("whatsapp:12345:15550000001")).toBe("15550000001");
    expect(phoneFromAddress("123456789@g.us")).toBeUndefined();
    expect(phoneFromAddress("Joni 15550000001")).toBeUndefined();
  });
  it("enforces the one-hop ceiling and rejects unsafe configuration", () => {
    expect(exceedsHopLimit(0, 1)).toBe(false);
    expect(exceedsHopLimit(1, 1)).toBe(true);
    expect(exceedsHopLimit(8, 1)).toBe(true);
    expect(exceedsHopLimit(NaN, 1)).toBe(true);
    expect(() =>
      parseLoopPolicy(raw.replace('"maxHops":1', '"maxHops":2')),
    ).toThrow();
    expect(() => parseLoopPolicy('{"accounts":[]}')).toThrow();
  });
  it("blocks agent senders in a group without treating other participants as agents", () => {
    const guard = new WhatsAppLoopGuard(),
      a = event();
    a.platformId = "123456789@g.us";
    a.message.isGroup = true;
    expect(guard.inspect(a, policy)).toBe("agent_external_max_hops");
    a.message.content = JSON.stringify({
      sender: "15550000099@s.whatsapp.net",
      text: "hello",
    });
    expect(guard.inspect(a, policy)).toBeUndefined();
  });
});
function setupDb() {
  process.env.WHATSAPP_LOOP_GUARD = '1';
  const db = initTestDb();
  db.exec("CREATE TABLE agent_groups(id TEXT PRIMARY KEY); INSERT INTO agent_groups VALUES ('test-A'),('test-B')");
  migration027.up(db);
  registerWhatsAppAccount('whatsapp', '15550000001');
  registerWhatsAppAccount('whatsapp-cloud', '15550000002');
  bindWhatsAppAgent('test-A','whatsapp'); bindWhatsAppAgent('test-B','whatsapp-cloud');
  db.exec(`
    CREATE TABLE agent_destinations(agent_group_id TEXT,local_name TEXT,target_type TEXT,target_id TEXT,created_at TEXT,PRIMARY KEY(agent_group_id,local_name));
    CREATE TABLE messaging_groups(id TEXT PRIMARY KEY,channel_type TEXT,platform_id TEXT,instance TEXT,name TEXT);
    CREATE TABLE messaging_group_agents(id TEXT PRIMARY KEY,messaging_group_id TEXT,agent_group_id TEXT,engage_mode TEXT,engage_pattern TEXT,sender_scope TEXT,ignored_message_policy TEXT,session_mode TEXT,priority INTEGER,created_at TEXT);
    INSERT INTO messaging_groups VALUES ('chat-B','whatsapp','whatsapp:12345:15550000002','whatsapp-cloud','B'),('chat-A','whatsapp','15550000001@s.whatsapp.net','whatsapp','A');
  `);
  return db;
}
function destination(
  from: string,
  target: string,
  type: "agent" | "channel" = "channel",
) {
  return {
    agent_group_id: from,
    local_name: target,
    target_type: type,
    target_id: target,
    created_at: "2026-01-01",
  };
}
describe("persisted destination and origin wiring graph", () => {
  it("rejects A -> WhatsApp B -> WhatsApp A without changing the DB", () => {
    const db = setupDb();
    createDestination(destination("test-A", "chat-B"));
    expect(() => createDestination(destination("test-B", "chat-A"))).toThrow(
      /cycle blocked/,
    );
    expect(
      db.prepare("SELECT count(*) n FROM agent_destinations").get(),
    ).toEqual({ n: 1 });
  });
  it("rejects mixed internal/external return routes and external self loops", () => {
    setupDb();
    createDestination(destination("test-A", "test-B", "agent"));
    expect(() => createDestination(destination("test-B", "chat-A"))).toThrow(
      /cycle blocked/,
    );
    expect(() => createDestination(destination("test-A", "chat-A"))).toThrow(
      /cycle blocked/,
    );
  });
  it("blocks origin-chat auto-wiring atomically, including without the destinations module", () => {
    const db = setupDb();
    db.exec(
      "DROP TABLE agent_destinations; INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id) VALUES ('w-A','chat-B','test-A')",
    );
    expect(() =>
      createMessagingGroupAgent({
        id: "w-B",
        messaging_group_id: "chat-A",
        agent_group_id: "test-B",
        engage_mode: "pattern",
        engage_pattern: ".",
        sender_scope: "all",
        ignored_message_policy: "drop",
        session_mode: "shared",
        priority: 0,
        created_at: "2026-01-01",
      } as Parameters<typeof createMessagingGroupAgent>[0]),
    ).toThrow(/cycle blocked/);
    expect(
      db.prepare("SELECT count(*) n FROM messaging_group_agents").get(),
    ).toEqual({ n: 1 });
  });
  it("runtime guard detects a cycle inserted outside API; unrelated routes still work", () => {
    const db = setupDb();
    db.exec(
      "INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id) VALUES ('w-A','chat-B','test-A'),('w-B','chat-A','test-B')",
    );
    expect(() => assertWhatsAppWiring(destination("test-A", "chat-B"))).toThrow(
      /cycle blocked/,
    );
    expect(() =>
      assertWhatsAppWiring(destination("test-C", "chat-A")),
    ).not.toThrow();
  });
  it("keeps internal-only cycles valid and checks longer external cycles", () => {
    const internal = [
      { from: "A", to: "B", external: false },
      { from: "B", to: "A", external: false },
    ];
    expect(() => assertNoExternalCycle(internal)).not.toThrow();
    expect(() =>
      assertNoExternalCycle([
        { from: "A", to: "B", external: false },
        { from: "B", to: "C", external: true },
        { from: "C", to: "A", external: false },
      ]),
    ).toThrow();
  });
  it("disabled policy preserves legacy destination writes", () => {
    setupDb();
    delete process.env.WHATSAPP_LOOP_GUARD;
    createDestination(destination("test-A", "chat-B"));
    expect(() =>
      createDestination(destination("test-B", "chat-A")),
    ).not.toThrow();
  });
});

it("CLI destination-add and generic wiring-create cannot bypass cycle validation", async () => {
  const db = setupDb();
  createDestination(destination("test-A", "chat-B"));
  const add = lookup("destinations-add")!;
  await expect(
    add.handler(
      {
        agent_group_id: "test-B",
        local_name: "return",
        target_type: "channel",
        target_id: "chat-A",
      },
      { caller: "host" },
    ),
  ).rejects.toThrow(/cycle blocked/);
  const wire = lookup("wirings-create")!;
  await expect(
    wire.handler(
      wire.parseArgs({
        agent_group_id: "test-B",
        messaging_group_id: "chat-A",
      }),
      { caller: "host" },
    ),
  ).rejects.toThrow(/cycle blocked/);
  expect(db.prepare("SELECT count(*) n FROM agent_destinations").get()).toEqual(
    { n: 1 },
  );
  expect(
    db.prepare("SELECT count(*) n FROM messaging_group_agents").get(),
  ).toEqual({ n: 0 });
});
