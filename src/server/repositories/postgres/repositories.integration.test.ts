import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Agent, AgentAction } from "@/core/contracts";
import { actionToRow, agentToRow } from "@/server/database/mappers";
import { actions, agents, approvals } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { PostgresActionRepository } from "./action-repository";
import { PostgresAgentRepository } from "./agent-repository";
import { PostgresApprovalRepository } from "./approval-repository";
import { PostgresAuditRepository } from "./audit-repository";
import { PostgresTaskRepository } from "./task-repository";

const seedAgent: Agent = {
  id: "agent-cto",
  name: "CTO",
  role: "Direction technique",
  status: "available",
  authorizationLevel: 2,
  description: "desc",
};

function action(overrides: Partial<AgentAction> & Pick<AgentAction, "id">): AgentAction {
  return {
    initiatedByAgentId: "agent-cto",
    kind: "repository.push",
    risk: "sensitive",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    requestedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable)("Repositories PostgreSQL (intégration)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
    await ctx.handle.db.insert(agents).values(agentToRow(seedAgent));
  });

  it("migrations appliquées depuis une base vide : lecture agent + null", async () => {
    const repo = new PostgresAgentRepository(ctx.handle.db);
    expect(await repo.getById("agent-cto")).toEqual(seedAgent);
    expect(await repo.getById("inconnu")).toBeNull();
    expect(await repo.list()).toHaveLength(1);
  });

  it("crée une tâche et écrit l'audit dans la même transaction", async () => {
    const tasks = new PostgresTaskRepository(ctx.handle.db);
    const audit = new PostgresAuditRepository(ctx.handle.db);

    const result = await tasks.create({ title: "Tâche", assignedAgentId: "agent-cto" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((await tasks.getById(result.task.id))?.status).toBe("draft");
    }
    expect(await audit.query({ eventType: "task.created" })).toHaveLength(1);
  });

  it("applique les transitions valides et refuse les invalides / inconnues", async () => {
    const tasks = new PostgresTaskRepository(ctx.handle.db);
    const created = await tasks.create({ title: "Tâche" });
    if (!created.ok) throw new Error("création échouée");

    expect((await tasks.transition(created.task.id, "queued")).ok).toBe(true);
    expect(await tasks.transition(created.task.id, "succeeded")).toMatchObject({
      ok: false,
      reason: "invalid_transition",
    });
    expect(await tasks.transition("task-inconnue", "queued")).toMatchObject({
      ok: false,
      reason: "task_not_found",
    });
  });

  it("hydrate Task.actionIds depuis actions.task_id (source unique)", async () => {
    const tasks = new PostgresTaskRepository(ctx.handle.db);
    const created = await tasks.create({ title: "Tâche" });
    if (!created.ok) throw new Error("création échouée");

    await ctx.handle.db
      .insert(actions)
      .values(actionToRow(action({ id: "action-1", taskId: created.task.id })));

    expect((await tasks.getById(created.task.id))?.actionIds).toEqual(["action-1"]);
  });

  it("liste et filtre les actions par statut d'approbation", async () => {
    const repo = new PostgresActionRepository(ctx.handle.db);
    await ctx.handle.db.insert(actions).values(actionToRow(action({ id: "action-p" })));
    await ctx.handle.db
      .insert(actions)
      .values(actionToRow(action({ id: "action-a", approvalStatus: "approved" })));

    expect(await repo.list({ approvalStatus: "pending" })).toHaveLength(1);
    expect(await repo.list()).toHaveLength(2);
    expect(await repo.getById("action-inconnue")).toBeNull();
  });

  it("FK : action initiée par un agent inexistant est rejetée", async () => {
    await expect(
      ctx.handle.db
        .insert(actions)
        .values(actionToRow(action({ id: "action-x", initiatedByAgentId: "agent-fantome" }))),
    ).rejects.toThrow();
  });

  it("CHECK : authorization_level hors [0,3] est rejeté", async () => {
    await expect(
      ctx.handle.db
        .insert(agents)
        .values({ ...agentToRow(seedAgent), id: "agent-bad", authorizationLevel: 9 }),
    ).rejects.toThrow();
  });

  it("UNIQUE : deux décisions définitives pour la même action sont rejetées", async () => {
    await ctx.handle.db.insert(actions).values(actionToRow(action({ id: "action-u" })));
    await ctx.handle.db.insert(approvals).values({
      id: "ap-1",
      actionId: "action-u",
      decision: "approved",
      decidedByLabel: "op",
      reason: null,
      decidedAt: new Date(),
    });

    await expect(
      ctx.handle.db.insert(approvals).values({
        id: "ap-2",
        actionId: "action-u",
        decision: "rejected",
        decidedByLabel: "op",
        reason: "trop tard",
        decidedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("approbations : listForAction", async () => {
    const repo = new PostgresApprovalRepository(ctx.handle.db);
    await ctx.handle.db.insert(actions).values(actionToRow(action({ id: "action-ap" })));
    await ctx.handle.db.insert(approvals).values({
      id: "ap-x",
      actionId: "action-ap",
      decision: "approved",
      decidedByLabel: "op",
      reason: null,
      decidedAt: new Date(),
    });
    expect(await repo.listForAction("action-ap")).toHaveLength(1);
    expect(await repo.listForAction("action-inconnue")).toHaveLength(0);
  });

  it("audit : append / appendMany / query / list, avec validation Zod", async () => {
    const audit = new PostgresAuditRepository(ctx.handle.db);
    await audit.append({
      id: "audit-a",
      occurredAt: "2026-07-21T08:00:00.000Z",
      eventType: "task.created",
      actor: { kind: "system", id: "icos" },
      details: { note: "x" },
    });
    await audit.appendMany([
      {
        id: "audit-b",
        occurredAt: "2026-07-21T08:01:00.000Z",
        eventType: "action.decided",
        actor: { kind: "human", id: "op" },
        details: { decision: "approved" },
      },
    ]);

    expect(await audit.list()).toHaveLength(2);
    expect(await audit.query({ actorId: "op" })).toHaveLength(1);
    // Entrée invalide (nombre non fini) rejetée par Zod avant insertion.
    await expect(
      audit.append({
        id: "audit-c",
        occurredAt: "2026-07-21T08:02:00.000Z",
        eventType: "task.created",
        actor: { kind: "system", id: "icos" },
        details: { bad: Number.POSITIVE_INFINITY },
      }),
    ).rejects.toThrow();
  });

  it("isolation : chaque test repart d'un état vide (un seul agent seedé)", async () => {
    const repo = new PostgresAgentRepository(ctx.handle.db);
    expect(await repo.list()).toHaveLength(1);
  });
});
