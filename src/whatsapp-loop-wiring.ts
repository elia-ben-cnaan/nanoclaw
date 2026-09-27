import { getDb, hasTable } from "./db/connection.js";
import {
  assertNoExternalCycle,
  loopPolicy,
  owners,
  type RouteEdge,
} from "./whatsapp-loop-guard.js";

type Destination = {
  agent_group_id: string;
  target_type: string;
  target_id: string;
};
/** Call inside the mutation transaction, before either destination or wiring INSERT. */
export function assertWhatsAppWiring(candidate: Destination): void {
  const policy = loopPolicy();
  if (!policy) return;
  const db = getDb();
  const groups = db
    .prepare("SELECT id,channel_type,platform_id FROM messaging_groups")
    .all() as { id: string; channel_type: string; platform_id: string }[];
  const routes: Destination[] = hasTable(db, "agent_destinations")
    ? (db
        .prepare(
          "SELECT agent_group_id,target_type,target_id FROM agent_destinations",
        )
        .all() as Destination[])
    : [];
  // Origin-chat replies are allowed without destination ACL rows, so wiring is also an edge.
  const wires = db
    .prepare(
      "SELECT agent_group_id,messaging_group_id FROM messaging_group_agents",
    )
    .all() as { agent_group_id: string; messaging_group_id: string }[];
  routes.push(
    ...wires.map((w) => ({
      agent_group_id: w.agent_group_id,
      target_type: "channel",
      target_id: w.messaging_group_id,
    })),
  );
  routes.push(candidate);
  const edges: RouteEdge[] = [];
  const proposed: RouteEdge[] = [];
  for (const r of routes) {
    const start = edges.length;
    if (r.target_type === "agent")
      edges.push({ from: r.agent_group_id, to: r.target_id, external: false });
    else {
      const mg = groups.find((g) => g.id === r.target_id);
      if (mg?.channel_type !== "whatsapp") continue;
      for (const to of owners(policy, mg.platform_id))
        edges.push({ from: r.agent_group_id, to, external: true });
    }
    if (r === candidate) proposed.push(...edges.slice(start));
  }
  assertNoExternalCycle(edges, proposed);
}
