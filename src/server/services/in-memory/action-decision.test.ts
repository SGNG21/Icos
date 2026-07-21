import { describe, expect, it } from "vitest";

import type { AgentAction, Approval, AuditEntry } from "@/core/contracts";
import { InMemoryAuditLog, type AuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";
import { demoActions } from "@/features/actions/data";

import { InMemoryActionDecisionStore } from "./action-decision-store";
import { InMemoryActionService } from "./action-service";
import { InMemoryApprovalService } from "./approval-service";

class FailingAuditLog implements AuditLog {
  append(): AuditEntry {
    throw new Error("audit indisponible");
  }
  appendMany(): readonly AuditEntry[] {
    throw new Error("audit indisponible");
  }
  list(): readonly AuditEntry[] {
    return [];
  }
  query(): readonly AuditEntry[] {
    return [];
  }
}

function approvalFor(action: AgentAction): Approval {
  return {
    id: "approval-test",
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
  it("filtre par statut d'approbation et isole ses résultats", () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const actions = new InMemoryActionService(store);

    const pending = actions.list({ approvalStatus: "pending" });
    expect(pending.length).toBeGreaterThan(0);

    const listed = actions.list();
    listed[0].kind = "corrompu";
    expect(actions.list()[0].kind).not.toBe("corrompu");
    expect(demoActions[0].kind).not.toBe("corrompu");
  });
});

describe("InMemoryActionDecisionUnitOfWork (atomicité)", () => {
  it("succès : approbation, action et audit sont cohérents", () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const audit = new InMemoryAuditLog();
    const uow = new InMemoryActionDecisionUnitOfWork(store, audit);
    const approvals = new InMemoryApprovalService(store);
    const actions = new InMemoryActionService(store);

    const target = demoActions[0];
    const updated: AgentAction = { ...target, approvalStatus: "approved" };

    const result = uow.commitDecision({
      approval: approvalFor(target),
      action: updated,
      auditEntries: auditFor(target),
    });

    expect(result.ok).toBe(true);
    expect(actions.getById(target.id)?.approvalStatus).toBe("approved");
    expect(approvals.listForAction(target.id)).toHaveLength(1);
    expect(audit.list()).toHaveLength(2);
  });

  it("échec de l'audit : aucune approbation et aucune modification d'action", () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const uow = new InMemoryActionDecisionUnitOfWork(store, new FailingAuditLog());
    const approvals = new InMemoryApprovalService(store);
    const actions = new InMemoryActionService(store);

    const target = demoActions[0];
    const before = actions.getById(target.id)?.approvalStatus;

    const result = uow.commitDecision({
      approval: approvalFor(target),
      action: { ...target, approvalStatus: "approved" },
      auditEntries: auditFor(target),
    });

    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
    expect(actions.getById(target.id)?.approvalStatus).toBe(before);
    expect(approvals.listForAction(target.id)).toHaveLength(0);
  });

  it("action absente : rien n'est appliqué (ni approbation, ni audit)", () => {
    const store = new InMemoryActionDecisionStore(demoActions);
    const audit = new InMemoryAuditLog();
    const uow = new InMemoryActionDecisionUnitOfWork(store, audit);
    const approvals = new InMemoryApprovalService(store);

    const ghost: AgentAction = {
      id: "action-inexistante",
      initiatedByAgentId: "agent-cto",
      kind: "ghost",
      risk: "reversible",
      requiresHumanApproval: true,
      approvalStatus: "approved",
      requestedAt: "2026-07-21T10:00:00.000Z",
    };

    const result = uow.commitDecision({
      approval: approvalFor(ghost),
      action: ghost,
      auditEntries: auditFor(ghost),
    });

    expect(result).toMatchObject({ ok: false, reason: "action_not_found" });
    expect(approvals.list()).toHaveLength(0);
    expect(audit.list()).toHaveLength(0);
  });
});
