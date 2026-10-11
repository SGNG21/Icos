import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rowToAuditEntry } from "@/server/database/mappers";
import { agents as agentsTable, auditEntries } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  type PgContext,
} from "@/server/database/testing/pg-support";
import { toolConnectorHealth, toolExecutions } from "@/server/database/tool-gateway-schema";
import type { Container } from "@/server/container";
import {
  countDispatchableConnectors,
  countLiveToolGrants,
  measureRealtime,
  resetRealtimeCallerWiredForTests,
} from "@/server/cognitive/honest-probes";
import { buildRealtimeContextSource } from "@/server/cognitive/realtime-context-source";
import { PostgresAgentRepository } from "@/server/repositories/postgres/agent-repository";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";

import { TOOL_GATEWAY_RUNTIME_KEY, getToolGatewayRuntime } from "./app";
import { bootToolGateway } from "./boot";
import { composeToolGateway } from "./composition";
import { grantRealtimeToRuntime } from "./realtime-grants";
import { RUNTIME_AGENT_ID } from "./runtime-agent";

/**
 * Real PostgreSQL (Testcontainers, migrations from zero). No real network: the boot path's
 * health probes need none (web: CONFIGURED; search without `healthPath`: CONFIGURED), and
 * the execution path below runs on a fetch double and a DNS double.
 */
const CONFIG = {
  instances: [
    {
      instanceId: "search-main",
      connectorId: "search",
      config: { baseUrl: "https://search.test/" },
    },
    { instanceId: "web-main", connectorId: "web" },
  ],
};
const ENV_KEYS = ["ICOS_TOOL_GATEWAY_CONFIG", "PERSISTENCE", "DATABASE_URL"] as const;

describe.skipIf(!dockerAvailable)("Tool Gateway boot + realtime on PostgreSQL", () => {
  let ctx: PgContext;
  let container: Container;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(async () => {
    ctx = await startPostgres();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ICOS_TOOL_GATEWAY_CONFIG = JSON.stringify(CONFIG);
    process.env.PERSISTENCE = "postgres";
    process.env.DATABASE_URL = ctx.container.getConnectionUri();
    delete (globalThis as Record<string, unknown>)[TOOL_GATEWAY_RUNTIME_KEY];
    container = {
      db: ctx.handle.db,
      agents: new PostgresAgentRepository(ctx.handle.db),
      audit: new PostgresAuditRepository(ctx.handle.db),
    } as unknown as Container;
  });
  afterAll(async () => {
    delete (globalThis as Record<string, unknown>)[TOOL_GATEWAY_RUNTIME_KEY];
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetRealtimeCallerWiredForTests();
    await stopPostgres(ctx);
  });

  it("BOOT writes health evidence, registers the level-0 runtime identity, grants nothing", async () => {
    const report = await bootToolGateway(container);
    expect(report).toEqual({ runtimeAgent: "created", reconciled: true });

    const health = await ctx.handle.db.select().from(toolConnectorHealth);
    expect(health.map((h) => [h.instanceId, h.status]).sort()).toEqual([
      ["search-main", "CONFIGURED"],
      ["web-main", "CONFIGURED"],
    ]);
    const [agent] = await ctx.handle.db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, RUNTIME_AGENT_ID));
    expect(agent).toMatchObject({ authorizationLevel: 0 });

    expect(await countLiveToolGrants(ctx.handle.db)).toBe(0);
    expect(await countDispatchableConnectors(ctx.handle.db)).toBe(2);
    expect(
      await measureRealtime(ctx.handle.db, { ICOS_TOOL_GATEWAY_CONFIG: JSON.stringify(CONFIG) }),
    ).toEqual({
      declared: 2,
      healthy: 2,
      runtimeAgentGranted: false,
      callerWired: false,
      /* Healthy is not usable: no instance has the grant for its own tool. */
      usable: 0,
    });
  });

  it("ONE runtime per process: a second boot and the admin routes get the same instance", async () => {
    const first = await getToolGatewayRuntime(container);
    expect((await bootToolGateway(container)).runtimeAgent).toBe("present");
    expect(await getToolGatewayRuntime(container)).toBe(first);
  });

  it("OWNER GRANT through the gateway's setGrant path; probes count only LIVE grants", async () => {
    const rt = await getToolGatewayRuntime(container);
    const agents = new PostgresAgentRepository(ctx.handle.db);
    const result = await grantRealtimeToRuntime(
      { gateway: rt.gateway, agents },
      {
        owner: { id: "user-owner", status: "active", role: "owner" },
        reason: "Veille web pour les clients",
      },
    );
    expect(result.grants.every((g) => g.ok)).toBe(true);

    // Noise the old probe counted: an expired grant and a revoked one.
    await agents.ensureRegistered({
      id: "agent-other",
      name: "other",
      role: "test",
      status: "available",
      authorizationLevel: 0,
      description: "test",
    });
    const admin = { kind: "human" as const, id: "user-owner", roles: ["owner" as const] };
    const base = { tenantId: "default", agentId: "agent-other", reason: "test" };
    await rt.gateway.setGrant(
      admin,
      { ...base, toolId: "web-search", action: "SEARCH", expiresAt: "2020-01-01T00:00:00.000Z" },
      "grant",
    );
    await rt.gateway.setGrant(admin, { ...base, toolId: "web-fetch", action: "READ" }, "grant");
    await rt.gateway.setGrant(admin, { ...base, toolId: "web-fetch", action: "READ" }, "revoke");

    expect(await countLiveToolGrants(ctx.handle.db)).toBe(2);
    expect(
      (await measureRealtime(ctx.handle.db, { ICOS_TOOL_GATEWAY_CONFIG: JSON.stringify(CONFIG) }))
        .runtimeAgentGranted,
    ).toBe(true);
    const audit = (await ctx.handle.db.select().from(auditEntries)).map(rowToAuditEntry);
    expect(
      audit.filter(
        (e) => e.eventType === "tool.grant.changed" && e.details.agentId === RUNTIME_AGENT_ID,
      ),
    ).toHaveLength(2);
  });

  it("REALTIME SOURCE executes through the gateway; audit rows carry the scope context", async () => {
    // Same database, stores, agents and audit; only the network is a double.
    const seen: string[] = [];
    const rt = composeToolGateway({
      backend: "postgres",
      db: ctx.handle.db,
      agents: new PostgresAgentRepository(ctx.handle.db),
      audit: new PostgresAuditRepository(ctx.handle.db),
      config: CONFIG,
      resolveHost: async () => ["93.184.215.14"],
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(String(input));
        return Response.json({
          results: [{ title: "Aides 2026", url: "https://example.org/aides", content: "MaPrime" }],
        });
      }) as typeof fetch,
    });
    const source = buildRealtimeContextSource({
      gateway: rt.gateway,
      env: { ICOS_TOOL_GATEWAY_CONFIG: JSON.stringify(CONFIG) },
    });
    const items = await source.candidates({
      scope: { tenantId: "default", userId: "u-1", clientId: "lds-renov", projectId: null },
      turnText: "Cherche sur le web les aides rénovation 2026",
      conversationId: "conv-pg-1",
      turnId: "turn-pg-1",
      now: new Date(),
    });
    expect(items.map((i) => i.kind)).toEqual(["runtime_state", "external_data"]);
    expect(items[1]).toMatchObject({ trust: "untrusted" });
    expect(items[1]!.text).toContain("[source: https://example.org/aides");
    expect(seen).toHaveLength(1);

    const [exec] = await ctx.handle.db.select().from(toolExecutions);
    expect(exec).toMatchObject({
      requesterAgentId: RUNTIME_AGENT_ID,
      toolId: "web-search",
      status: "SUCCEEDED",
      resultTrust: "UNTRUSTED_EXTERNAL_DATA",
    });
    const recorded = (await ctx.handle.db.select().from(auditEntries))
      .map(rowToAuditEntry)
      .filter(
        (e) => e.eventType === "tool.execution.recorded" && e.details.toolExecutionId === exec!.id,
      );
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    for (const e of recorded) {
      expect(e.details.context).toEqual({
        clientId: "lds-renov",
        conversationId: "conv-pg-1",
        turnId: "turn-pg-1",
      });
    }
    expect(
      (await measureRealtime(ctx.handle.db, { ICOS_TOOL_GATEWAY_CONFIG: JSON.stringify(CONFIG) }))
        .callerWired,
    ).toBe(true);
  });
});
