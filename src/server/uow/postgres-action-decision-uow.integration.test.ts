import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AgentAction, Approval, AuditEntry } from "@/core/contracts";
import { actionToRow, agentToRow } from "@/server/database/mappers";
import { actions, agents, approvals, auditEntries } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { PostgresActionDecisionUnitOfWork } from "./postgres-action-decision-uow";

const ISO = "2026-07-22T10:00:00.000Z";

function pendingAction(id: string): AgentAction {
  return {
    id,
    initiatedByAgentId: "agent-cto",
    kind: "repository.push",
    risk: "sensitive",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    requestedAt: ISO,
  };
}

function decisionInput(
  action: AgentAction,
  ids: { approvalId?: string; auditA?: string; auditB?: string } = {},
): { approval: Approval; action: AgentAction; auditEntries: AuditEntry[] } {
  return {
    approval: {
      id: ids.approvalId ?? "approval-1",
      actionId: action.id,
      decidedBy: "op",
      decision: "approved",
      decidedAt: ISO,
    },
    action: { ...action, approvalStatus: "approved" },
    auditEntries: [
      {
        id: ids.auditA ?? "audit-a",
        occurredAt: ISO,
        eventType: "approval.recorded",
        actor: { kind: "human", id: "op" },
        actionId: action.id,
        details: { decision: "approved" },
      },
      {
        id: ids.auditB ?? "audit-b",
        occurredAt: ISO,
        eventType: "action.decided",
        actor: { kind: "human", id: "op" },
        actionId: action.id,
        details: { approvalStatus: "approved" },
      },
    ],
  };
}

describe.skipIf(!dockerAvailable)("PostgresActionDecisionUnitOfWork (intégration)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
    await ctx.handle.db.insert(agents).values(
      agentToRow({
        id: "agent-cto",
        name: "CTO",
        role: "tech",
        status: "available",
        authorizationLevel: 2,
        description: "d",
      }),
    );
  });

  it("succès : approbation, action mise à jour et audit cohérents", async () => {
    const uow = new PostgresActionDecisionUnitOfWork(ctx.handle.db);
    const action = pendingAction("action-1");
    await ctx.handle.db.insert(actions).values(actionToRow(action));

    const result = await uow.commitDecision(decisionInput(action));

    expect(result.ok).toBe(true);
    const [row] = await ctx.handle.db.select().from(actions).where(eq(actions.id, "action-1"));
    expect(row.approvalStatus).toBe("approved");
    expect(await ctx.handle.db.select().from(approvals)).toHaveLength(1);
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(2);
  });

  it("action absente → action_not_found", async () => {
    const uow = new PostgresActionDecisionUnitOfWork(ctx.handle.db);
    const result = await uow.commitDecision(decisionInput(pendingAction("action-absente")));
    expect(result).toMatchObject({ ok: false, reason: "action_not_found" });
  });

  it("action déjà terminale → already_decided", async () => {
    const uow = new PostgresActionDecisionUnitOfWork(ctx.handle.db);
    const action = { ...pendingAction("action-2"), approvalStatus: "approved" as const };
    await ctx.handle.db.insert(actions).values(actionToRow(action));

    const result = await uow.commitDecision(decisionInput(action));
    expect(result).toMatchObject({ ok: false, reason: "already_decided" });
  });

  it("deux décisions concurrentes : une seule réussit", async () => {
    const uow = new PostgresActionDecisionUnitOfWork(ctx.handle.db);
    const action = pendingAction("action-c");
    await ctx.handle.db.insert(actions).values(actionToRow(action));

    const [a, b] = await Promise.all([
      uow.commitDecision(
        decisionInput(action, { approvalId: "ap-a", auditA: "au-a1", auditB: "au-a2" }),
      ),
      uow.commitDecision(
        decisionInput(action, { approvalId: "ap-b", auditA: "au-b1", auditB: "au-b2" }),
      ),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ok: false, reason: "already_decided" });
    expect(await ctx.handle.db.select().from(approvals)).toHaveLength(1);
    // Seul l'audit du gagnant est présent (2 entrées).
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(2);
    const [row] = await ctx.handle.db.select().from(actions).where(eq(actions.id, "action-c"));
    expect(row.approvalStatus).toBe("approved");
  });

  it("rollback : échec tardif à l'insertion d'audit → rien conservé", async () => {
    const uow = new PostgresActionDecisionUnitOfWork(ctx.handle.db);
    const action = pendingAction("action-r");
    await ctx.handle.db.insert(actions).values(actionToRow(action));
    // Collision connue sur un id d'audit, provoquant l'échec APRÈS l'insertion
    // de l'approbation et la mise à jour de l'action, dans la même transaction.
    await ctx.handle.db.insert(auditEntries).values({
      id: "audit-collision",
      eventType: "task.created",
      actorType: "system",
      actorLabel: "icos",
      details: {},
      occurredAt: new Date(ISO),
    });

    await expect(
      uow.commitDecision(decisionInput(action, { auditA: "audit-collision" })),
    ).rejects.toThrow();

    const [row] = await ctx.handle.db.select().from(actions).where(eq(actions.id, "action-r"));
    expect(row.approvalStatus).toBe("pending");
    expect(await ctx.handle.db.select().from(approvals)).toHaveLength(0);
    // Seule l'entrée de collision préexistante subsiste (aucun audit partiel).
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(1);
  });

  it("rollback : échec à l'insertion de l'approbation → aucune mutation conservée", async () => {
    const uow = new PostgresActionDecisionUnitOfWork(ctx.handle.db);
    const action = pendingAction("action-r2");
    await ctx.handle.db.insert(actions).values(actionToRow(action));
    // Approbation préexistante (pour une AUTRE action) avec l'id de collision.
    const other = pendingAction("action-other");
    await ctx.handle.db.insert(actions).values(actionToRow(other));
    await ctx.handle.db.insert(approvals).values({
      id: "approval-collision",
      actionId: "action-other",
      decision: "approved",
      decidedByLabel: "op",
      reason: null,
      decidedAt: new Date(ISO),
    });

    await expect(
      uow.commitDecision(decisionInput(action, { approvalId: "approval-collision" })),
    ).rejects.toThrow();

    const [row] = await ctx.handle.db.select().from(actions).where(eq(actions.id, "action-r2"));
    expect(row.approvalStatus).toBe("pending");
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(0);
  });
});
