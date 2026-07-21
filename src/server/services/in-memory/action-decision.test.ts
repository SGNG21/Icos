import { describe, expect, it } from "vitest";

import type { AgentAction, Approval, AuditEntry } from "@/core/contracts";
import { InMemoryAuditLog, type AuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";
import { demoActions } from "@/features/actions/data";

import { InMemoryActionDecisionStore } from "./action-decision-store";
import { InMemoryActionRepository } from "./action-repository";
import { InMemoryApprovalRepository } from "./approval-repository";

class FailingAuditLog implements AuditLog {
  append(): AuditEntry {
    throw new Error("audit indisponible");
  }
  appendMany(): AuditEntry[] {
    throw new Error("audit indisponible");
  }
  list(): AuditEntry[] {
    return [];
  }
  query(): AuditEntry[] {
    return [];
  }
}

function approvalFor(action: AgentAction, id = "approval-test"): Approval {
  return {
    id,
    actionId: action.id,
    decidedBy: "Opérateur (simulé)",
    decision: "approved",
    decidedAt: "2026-07-21T10:00:00.000Z",
  };
}

function auditFor(action: AgentAction): AuditEntry[] {
  return [
    {
      id: "audit-a",
      occurredAt: "2026-07-21T10:00:00.000Z",
      eventType: "approval.recorded",
      actor: { kind: "human", id: "Opérateur (simulé)" },
      actionId: action.id,
      details: { decision: "approved" },
    },
    {
      id: "audit-b",
      occurredAt: "2026-07-21T10:00:00.000Z",
      eventType: "action.decided",
      actor: { kind: "human", id: "Opérateur (simulé)" },
      actionId: action.id,
      details: { approvalStatus: "approved" },
    },
  ];
}

describe("InMemoryActionDecisionStore (lecture)", () => {
  it("filtre par statut d'approbation et isole ses résultats", async () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const actions = new InMemoryActionRepository(store);

    const pending = await actions.list({ approvalStatus: "pending" });
    expect(pending.length).toBeGreaterThan(0);

    const listed = await actions.list();
    listed[0].kind = "corrompu";
    expect((await actions.list())[0].kind).not.toBe("corrompu");
    expect(demoActions[0].kind).not.toBe("corrompu");
  });

  it("getById retourne null pour une action inconnue", async () => {
    const actions = new InMemoryActionRepository(new InMemoryActionDecisionStore(demoActions));
    expect(await actions.getById("action-inconnue")).toBeNull();
  });
});

describe("InMemoryActionDecisionUnitOfWork (atomicité)", () => {
  it("succès : approbation, action et audit sont cohérents", async () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const audit = new InMemoryAuditLog();
    const uow = new InMemoryActionDecisionUnitOfWork(store, audit);
    const approvals = new InMemoryApprovalRepository(store);
    const actions = new InMemoryActionRepository(store);

    const target = demoActions[0];
    const updated: AgentAction = { ...target, approvalStatus: "approved" };

    const result = await uow.commitDecision({
      approval: approvalFor(target),
      action: updated,
      auditEntries: auditFor(target),
    });

    expect(result.ok).toBe(true);
    expect((await actions.getById(target.id))?.approvalStatus).toBe("approved");
    expect(await approvals.listForAction(target.id)).toHaveLength(1);
    expect(audit.list()).toHaveLength(2);
  });

  it("échec de l'audit : aucune approbation et aucune modification d'action", async () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const uow = new InMemoryActionDecisionUnitOfWork(store, new FailingAuditLog());
    const approvals = new InMemoryApprovalRepository(store);
    const actions = new InMemoryActionRepository(store);

    const target = demoActions[0];
    const before = (await actions.getById(target.id))?.approvalStatus;

    const result = await uow.commitDecision({
      approval: approvalFor(target),
      action: { ...target, approvalStatus: "approved" },
      auditEntries: auditFor(target),
    });

    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
    expect((await actions.getById(target.id))?.approvalStatus).toBe(before);
    expect(await approvals.listForAction(target.id)).toHaveLength(0);
  });

  it("action absente : rien n'est appliqué (ni approbation, ni audit)", async () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const audit = new InMemoryAuditLog();
    const uow = new InMemoryActionDecisionUnitOfWork(store, audit);
    const approvals = new InMemoryApprovalRepository(store);

    const ghost: AgentAction = {
      id: "action-inexistante",
      initiatedByAgentId: "agent-cto",
      kind: "ghost",
      risk: "reversible",
      requiresHumanApproval: true,
      approvalStatus: "approved",
      requestedAt: "2026-07-21T10:00:00.000Z",
    };

    const result = await uow.commitDecision({
      approval: approvalFor(ghost),
      action: ghost,
      auditEntries: auditFor(ghost),
    });

    expect(result).toMatchObject({ ok: false, reason: "action_not_found" });
    expect(await approvals.list()).toHaveLength(0);
    expect(audit.list()).toHaveLength(0);
  });

  it("garde de l'UoW : action déjà décidée → already_decided", async () => {
    // Le store contient une action déjà « approved ».
    const decided: AgentAction = { ...demoActions[0], approvalStatus: "approved" };
    const store = new InMemoryActionDecisionStore([decided]);
    const audit = new InMemoryAuditLog();
    const uow = new InMemoryActionDecisionUnitOfWork(store, audit);

    const result = await uow.commitDecision({
      approval: approvalFor(decided),
      action: { ...decided, approvalStatus: "rejected" },
      auditEntries: auditFor(decided),
    });

    expect(result).toMatchObject({ ok: false, reason: "already_decided" });
    expect(audit.list()).toHaveLength(0);
  });

  it("deux décisions concurrentes dans la même instance : une seule réussit", async () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const audit = new InMemoryAuditLog();
    const uow = new InMemoryActionDecisionUnitOfWork(store, audit);
    const target = demoActions[0];

    const [a, b] = await Promise.all([
      uow.commitDecision({
        approval: approvalFor(target, "approval-a"),
        action: { ...target, approvalStatus: "approved" },
        auditEntries: auditFor(target),
      }),
      uow.commitDecision({
        approval: approvalFor(target, "approval-b"),
        action: { ...target, approvalStatus: "rejected" },
        auditEntries: auditFor(target),
      }),
    ]);

    const successes = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ok: false, reason: "already_decided" });
    // Une seule approbation et un seul lot d'audit (2 entrées) enregistrés.
    expect(audit.list()).toHaveLength(2);
  });
});
