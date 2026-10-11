import { describe, expect, it } from "vitest";

import { InMemoryAgentRepository } from "@/server/services/in-memory/agent-repository";

import { composeToolGateway } from "./composition";
import { grantRealtimeToRuntime } from "./realtime-grants";
import { RUNTIME_AGENT_ID } from "./runtime-agent";
import { ArrayAudit } from "./test-fixtures";

function setup() {
  const audit = new ArrayAudit();
  const agents = new InMemoryAgentRepository([]);
  const rt = composeToolGateway({ backend: "memory", agents, audit: audit as never });
  return { audit, agents, rt };
}
const owner = { id: "user-owner", status: "active" as const, role: "owner" as const };

describe("owner command: explicit realtime grants for the runtime identity", () => {
  it("creates exactly web-search:SEARCH and web-fetch:READ, with grantor and reason, audited", async () => {
    const { audit, agents, rt } = setup();
    const result = await grantRealtimeToRuntime(
      { gateway: rt.gateway, agents },
      { owner, reason: "Veille web pour les clients" },
    );
    expect(result.runtimeAgent).toBe("created");
    expect(result.grants.every((g) => g.ok)).toBe(true);
    const grants = await rt.gateway.listGrants("default", RUNTIME_AGENT_ID);
    expect(grants.map((g) => `${g.toolId}:${g.action}`).sort()).toEqual([
      "web-fetch:READ",
      "web-search:SEARCH",
    ]);
    for (const g of grants) {
      expect(g).toMatchObject({ grantedBy: "user-owner", reason: "Veille web pour les clients" });
    }
    expect(audit.entries.filter((e) => e.eventType === "tool.grant.changed")).toHaveLength(2);
  });

  it("a human without agentCapabilities.write is refused and the refusal is audited", async () => {
    const { audit, agents, rt } = setup();
    const result = await grantRealtimeToRuntime(
      { gateway: rt.gateway, agents },
      { owner: { ...owner, role: "viewer" }, reason: "x", only: "search" },
    );
    expect(result.grants).toEqual([expect.objectContaining({ toolId: "web-search", ok: false })]);
    expect(await rt.gateway.listGrants("default", RUNTIME_AGENT_ID)).toEqual([]);
    expect(audit.entries.at(-1)!.details.reason).toBe("GRANT_CHANGE_REFUSED");
  });

  it("refuses without a reason or for an inactive human", async () => {
    const { agents, rt } = setup();
    await expect(
      grantRealtimeToRuntime({ gateway: rt.gateway, agents }, { owner, reason: " " }),
    ).rejects.toThrow("REALTIME_GRANT_REASON_REQUIRED");
    await expect(
      grantRealtimeToRuntime(
        { gateway: rt.gateway, agents },
        { owner: { ...owner, status: "disabled" }, reason: "x" },
      ),
    ).rejects.toThrow("REALTIME_GRANT_OWNER_NOT_ACTIVE");
  });
});
