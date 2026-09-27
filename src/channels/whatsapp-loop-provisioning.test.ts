import { initTestDb, closeDb } from '../db/connection.js';
import { migration027 } from '../db/migrations/027-whatsapp-agent-identities.js';
import { registerWhatsAppAccount } from '../whatsapp-agent-identities.js';
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../provision-handler.js", () => ({ provisionPilotAtPress: vi.fn() }));
vi.mock("./telegram-joni.js", () => ({
  mirrorToSupervisor: vi.fn(),
  outboundMirrorText: vi.fn(),
  wireJoniChat: vi.fn(),
}));
vi.mock("../db/messaging-groups.js", () => ({
  getMessagingGroupAgents: vi.fn(),
  getMessagingGroupByPlatform: vi.fn(),
}));
import { wrapWithPilotProvisioning } from "./whatsapp-cloud-pilot.js";
import { provisionPilotAtPress } from "../provision-handler.js";
import { mirrorToSupervisor, wireJoniChat } from "./telegram-joni.js";
import { getMessagingGroupByPlatform } from "../db/messaging-groups.js";
import type { ChannelAdapter, ChannelSetup } from "./adapter.js";
afterEach(() => {
  delete process.env.WHATSAPP_LOOP_GUARD; closeDb();
  vi.clearAllMocks();
});
it("drops known agent accounts before Cloud provisioning, mirroring, acknowledgement and host routing", async () => {
  process.env.WHATSAPP_LOOP_GUARD='1';
  const db=initTestDb();db.exec('CREATE TABLE agent_groups(id TEXT PRIMARY KEY)');migration027.up(db);
  registerWhatsAppAccount('whatsapp-cloud','15552220001');
  let config: ChannelSetup | undefined;
  const deliver = vi.fn();
  const bridge = {
    name: "whatsapp-cloud",
    setup: vi.fn(async (c) => {
      config = c;
    }),
    deliver,
  } as unknown as ChannelAdapter;
  const host = {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
  await wrapWithPilotProvisioning(bridge).setup(host);
  await config!.onInbound("whatsapp:123456:15552220001", null, {
    id: "synthetic-cloud-msg",
    kind: "chat-sdk",
    timestamp: "2026-01-01T00:00:00Z",
    content: {
      senderId: "15552220001",
      text: "Create an agent for me (agent4job)",
    },
  });
  expect(getMessagingGroupByPlatform).not.toHaveBeenCalled();
  expect(provisionPilotAtPress).not.toHaveBeenCalled();
  expect(wireJoniChat).not.toHaveBeenCalled();
  expect(mirrorToSupervisor).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
  expect(host.onInbound).not.toHaveBeenCalled();
});
