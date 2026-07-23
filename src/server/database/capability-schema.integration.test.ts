import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { agentCapabilities, agents, capabilities } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

describe.skipIf(!dockerAvailable)("capability schema (Testcontainers)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
  });

  async function seedAgent(): Promise<void> {
    await ctx.handle.db.insert(agents).values({
      id: "agent-1",
      name: "Test Agent",
      role: "operator",
      status: "available",
      authorizationLevel: 2,
      description: "Agent de test",
    });
  }

  async function seedCapability(key = "code.review"): Promise<void> {
    await ctx.handle.db.insert(capabilities).values({
      id: "cap-1",
      key,
      name: "Code Review",
      category: "code",
      status: "proposed",
      createdAt: new Date("2026-07-23T08:00:00.000Z"),
      updatedAt: new Date("2026-07-23T08:00:00.000Z"),
    });
  }

  it("rejette un status hors énumération via CHECK", async () => {
    await expect(
      ctx.handle.db.execute(sql`
        INSERT INTO capabilities (id, key, name, category, status, created_at, updated_at)
        VALUES ('cap-bad', 'bad.key', 'Bad', 'test', 'invalid_status', NOW(), NOW())
      `),
    ).rejects.toThrow();
  });

  it("rejette un event_type capability hors énumération via CHECK étendu", async () => {
    await expect(
      ctx.handle.db.execute(sql`
        INSERT INTO audit_entries (id, event_type, actor_type, actor_label, details, occurred_at)
        VALUES ('a1', 'capability.nonexistent', 'system', 'test', '{}', NOW())
      `),
    ).rejects.toThrow();
  });

  it("accepte un event_type capability valide", async () => {
    const result = await ctx.handle.db.execute(sql`
      INSERT INTO audit_entries (id, event_type, actor_type, actor_label, details, occurred_at)
      VALUES ('a2', 'capability.created', 'system', 'test', '{}', NOW())
      RETURNING event_type
    `);
    expect(result[0]?.event_type).toBe("capability.created");
  });

  it("impose UNIQUE(key) sur capabilities", async () => {
    await seedCapability("unique.key");
    await expect(seedCapability("unique.key")).rejects.toThrow();
  });

  it("impose UNIQUE(agent_id, capability_id) sur agent_capabilities", async () => {
    await seedAgent();
    await seedCapability();
    await ctx.handle.db.insert(agentCapabilities).values({
      id: "ac-1",
      agentId: "agent-1",
      capabilityId: "cap-1",
      assignedAt: new Date("2026-07-23T09:00:00.000Z"),
      assignedByUserId: "user-1",
    });
    await expect(
      ctx.handle.db.insert(agentCapabilities).values({
        id: "ac-2",
        agentId: "agent-1",
        capabilityId: "cap-1",
        assignedAt: new Date("2026-07-23T09:00:00.000Z"),
        assignedByUserId: "user-1",
      }),
    ).rejects.toThrow();
  });

  it("empêche la suppression d'un agent référencé par agent_capabilities (RESTRICT)", async () => {
    await seedAgent();
    await seedCapability();
    await ctx.handle.db.insert(agentCapabilities).values({
      id: "ac-3",
      agentId: "agent-1",
      capabilityId: "cap-1",
      assignedAt: new Date("2026-07-23T09:00:00.000Z"),
      assignedByUserId: "user-1",
    });
    await expect(
      ctx.handle.db.execute(sql`DELETE FROM agents WHERE id = 'agent-1'`),
    ).rejects.toThrow();
  });

  it("empêche la suppression d'une capability référencée par agent_capabilities (RESTRICT)", async () => {
    await seedAgent();
    await seedCapability();
    await ctx.handle.db.insert(agentCapabilities).values({
      id: "ac-4",
      agentId: "agent-1",
      capabilityId: "cap-1",
      assignedAt: new Date("2026-07-23T09:00:00.000Z"),
      assignedByUserId: "user-1",
    });
    await expect(
      ctx.handle.db.execute(sql`DELETE FROM capabilities WHERE id = 'cap-1'`),
    ).rejects.toThrow();
  });
});
