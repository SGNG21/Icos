import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { agents, agentCapabilities, auditEntries, capabilities } from "@/server/database/schema";
import { user } from "@/server/database/auth-schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { PostgresCapabilityUnitOfWork } from "./postgres-capability-uow";

describe.skipIf(!dockerAvailable)("PostgresCapabilityUnitOfWork atomicité", () => {
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

  const ISO = "2026-07-24T08:00:00.000Z";

  // Insère une entrée d'audit dont l'id sera en collision avec l'audit
  // que le UoW tente d'insérer dans sa transaction.
  async function seedAuditCollision(auditId: string): Promise<void> {
    await ctx.handle.db.insert(auditEntries).values({
      id: auditId,
      eventType: "capability.created",
      actorType: "system",
      actorLabel: "collision",
      details: {},
      occurredAt: new Date(ISO),
    });
  }

  async function seedCapability(
    id: string,
    key: string,
    status: "proposed" | "active" | "deprecated" | "retired" = "proposed",
  ): Promise<void> {
    await ctx.handle.db.insert(capabilities).values({
      id,
      key,
      name: "Test",
      category: "test",
      status,
      createdAt: new Date(ISO),
      updatedAt: new Date(ISO),
    });
  }

  async function seedUser(id: string): Promise<void> {
    await ctx.handle.db.insert(user).values({
      id,
      name: "Test User",
      email: `${id}@test.local`,
      emailVerified: true,
      status: "active",
      createdAt: new Date(ISO),
      updatedAt: new Date(ISO),
    });
  }

  async function seedAgent(): Promise<void> {
    await ctx.handle.db.insert(agents).values({
      id: "agent-uow",
      name: "UoW Test Agent",
      role: "operator",
      status: "available",
      authorizationLevel: 2,
      description: "Agent de test UoW",
    });
  }

  describe("create rollback", () => {
    it("annule la création en cas de collision d'audit", async () => {
      const uow = new PostgresCapabilityUnitOfWork(ctx.handle.db);
      await seedAuditCollision("audit-collision-create");

      const result = await uow.createCapabilityWithAudit({
        capability: {
          id: "cap-rb-create",
          key: "rb.create.key",
          name: "Rollback Create",
          category: "test",
          status: "proposed",
          createdAt: ISO,
          updatedAt: ISO,
        },
        auditEntry: {
          id: "audit-collision-create",
          occurredAt: ISO,
          eventType: "capability.created",
          actor: { kind: "human", id: "admin" },
          details: {},
        },
      });

      expect(result.ok).toBe(false);
      // La capacité ne doit pas exister (rollback)
      const rows = await ctx.handle.db
        .select()
        .from(capabilities)
        .where(eq(capabilities.id, "cap-rb-create"));
      expect(rows).toHaveLength(0);
    });
  });

  describe("changeStatus rollback", () => {
    it("rétablit le statut antérieur en cas de collision d'audit", async () => {
      await seedCapability("cap-rb-status", "rb.status");
      const uow = new PostgresCapabilityUnitOfWork(ctx.handle.db);
      await seedAuditCollision("audit-collision-status");

      const result = await uow.changeStatusWithAudit({
        id: "cap-rb-status",
        expectedStatus: "proposed",
        targetStatus: "active",
        auditEntry: {
          id: "audit-collision-status",
          occurredAt: ISO,
          eventType: "capability.status_changed",
          actor: { kind: "human", id: "admin" },
          details: { capabilityId: "cap-rb-status", from: "proposed", to: "active" },
        },
      });

      expect(result.ok).toBe(false);
      // Le statut doit être resté "proposed" (rollback)
      const [row] = await ctx.handle.db
        .select()
        .from(capabilities)
        .where(eq(capabilities.id, "cap-rb-status"));
      expect(row.status).toBe("proposed");
    });
  });

  describe("grant rollback", () => {
    it("annule l'octroi en cas de collision d'audit", async () => {
      await seedUser("user-1");
      await seedAgent();
      await seedCapability("cap-rb-grant", "rb.grant");
      const uow = new PostgresCapabilityUnitOfWork(ctx.handle.db);
      await seedAuditCollision("audit-collision-grant");

      const result = await uow.grantCapabilityWithAudit({
        agentCapability: {
          id: "ac-rb-grant",
          agentId: "agent-uow",
          capabilityId: "cap-rb-grant",
          assignedAt: ISO,
          assignedByUserId: "user-1",
        },
        auditEntry: {
          id: "audit-collision-grant",
          occurredAt: ISO,
          eventType: "agent_capability.granted",
          actor: { kind: "human", id: "admin" },
          details: {
            agentId: "agent-uow",
            capabilityId: "cap-rb-grant",
            assignedByUserId: "user-1",
          },
        },
      });

      expect(result.ok).toBe(false);
      // L'assignation ne doit pas exister (rollback)
      const rows = await ctx.handle.db
        .select()
        .from(agentCapabilities)
        .where(eq(agentCapabilities.id, "ac-rb-grant"));
      expect(rows).toHaveLength(0);
    });
  });

  describe("revoke rollback", () => {
    it("rétablit l'assignation en cas de collision d'audit", async () => {
      await seedUser("user-1");
      await seedAgent();
      await seedCapability("cap-rb-revoke", "rb.revoke");
      await ctx.handle.db.insert(agentCapabilities).values({
        id: "ac-rb-revoke",
        agentId: "agent-uow",
        capabilityId: "cap-rb-revoke",
        assignedAt: new Date(ISO),
        assignedByUserId: "user-1",
      });
      const uow = new PostgresCapabilityUnitOfWork(ctx.handle.db);
      await seedAuditCollision("audit-collision-revoke");

      const result = await uow.revokeCapabilityWithAudit({
        id: "ac-rb-revoke",
        auditEntry: {
          id: "audit-collision-revoke",
          occurredAt: ISO,
          eventType: "agent_capability.revoked",
          actor: { kind: "human", id: "admin" },
          details: {
            agentCapabilityId: "ac-rb-revoke",
            agentId: "agent-uow",
            capabilityId: "cap-rb-revoke",
          },
        },
      });

      expect(result.ok).toBe(false);
      // L'assignation doit toujours exister (rollback)
      const rows = await ctx.handle.db
        .select()
        .from(agentCapabilities)
        .where(eq(agentCapabilities.id, "ac-rb-revoke"));
      expect(rows).toHaveLength(1);
    });
  });
});
