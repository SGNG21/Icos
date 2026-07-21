import { describe, expect, it } from "vitest";

import type { Agent, AgentAction, Task } from "@/core/contracts";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryActionDecisionStore } from "@/server/services/in-memory/action-decision-store";
import { InMemoryActionRepository } from "@/server/services/in-memory/action-repository";
import { InMemoryAgentRepository } from "@/server/services/in-memory/agent-repository";
import { InMemoryApprovalRepository } from "@/server/services/in-memory/approval-repository";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";

import { recordActionDecision } from "./record-action-decision";

function agent(id: string, authorizationLevel: 0 | 1 | 2 | 3): Agent {
  return {
    id,
    name: id,
    role: "rôle",
    status: "available",
    authorizationLevel,
    description: "agent de test",
  };
}

function harness(opts: { agents: Agent[]; tasks: Task[]; actions: AgentAction[] }) {
  const store = new InMemoryActionDecisionStore(opts.actions);
  const audit = new InMemoryAuditLog();
  const uow = new InMemoryActionDecisionUnitOfWork(store, audit);
  let counter = 0;
  return {
    audit,
    actions: new InMemoryActionRepository(store),
    approvals: new InMemoryApprovalRepository(store),
    deps: {
      actions: new InMemoryActionRepository(store),
      agents: new InMemoryAgentRepository(opts.agents),
      tasks: {
        getById: (id: string): Promise<Task | null> =>
          Promise.resolve(opts.tasks.find((task) => task.id === id) ?? null),
      },
      uow,
      now: () => "2026-07-21T10:00:00.000Z",
      newId: (prefix: string) => `${prefix}-${++counter}`,
    },
  };
}

const pendingSensitive: AgentAction = {
  id: "action-x",
  initiatedByAgentId: "agent-op",
  kind: "repository.push",
  risk: "sensitive",
  requiresHumanApproval: true,
  approvalStatus: "pending",
  requestedAt: "2026-07-21T09:00:00.000Z",
};

describe("recordActionDecision", () => {
  it("résout l'agent depuis l'action : l'initiateur gouverne la décision d'exécution", async () => {
    // Un agent de haut niveau existe, mais l'initiateur (niveau 1) doit gouverner.
    const h = harness({
      agents: [agent("agent-op", 1), agent("agent-ceo", 3)],
      tasks: [],
      actions: [{ ...pendingSensitive, risk: "reversible" }],
    });

    const result = await recordActionDecision(h.deps, {
      actionId: "action-x",
      command: { decidedByLabel: "Opérateur", decision: "approved" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // reversible + niveau 1 (< 2) → refusé, prouvant que l'agent résolu est
      // bien l'initiateur et non un agent de haut niveau.
      expect(result.execution).toEqual({
        outcome: "refused",
        reason: "insufficient_authorization",
      });
    }
    expect(await h.approvals.listForAction("action-x")).toHaveLength(1);
    expect((await h.actions.getById("action-x"))?.approvalStatus).toBe("approved");
  });

  it("autorise l'exécution d'une action sensible approuvée par un opérateur suffisant", async () => {
    const h = harness({
      agents: [agent("agent-op", 2)],
      tasks: [],
      actions: [pendingSensitive],
    });

    const result = await recordActionDecision(h.deps, {
      actionId: "action-x",
      command: { decidedByLabel: "Opérateur", decision: "approved" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.execution).toEqual({ outcome: "allowed", reason: "authorized" });
    }
    expect(h.audit.list()).toHaveLength(2);
  });

  it("détecte un agent initiateur absent AVANT toute mutation", async () => {
    const h = harness({
      agents: [],
      tasks: [],
      actions: [pendingSensitive],
    });

    const result = await recordActionDecision(h.deps, {
      actionId: "action-x",
      command: { decidedByLabel: "Opérateur", decision: "approved" },
    });

    expect(result).toMatchObject({ ok: false, reason: "agent_not_found" });
    expect(await h.approvals.list()).toHaveLength(0);
    expect(h.audit.list()).toHaveLength(0);
    expect((await h.actions.getById("action-x"))?.approvalStatus).toBe("pending");
  });

  it("refuse une action déjà décidée", async () => {
    const h = harness({
      agents: [agent("agent-op", 2)],
      tasks: [],
      actions: [{ ...pendingSensitive, approvalStatus: "approved" }],
    });

    const result = await recordActionDecision(h.deps, {
      actionId: "action-x",
      command: { decidedByLabel: "Opérateur", decision: "rejected", reason: "trop tard" },
    });

    expect(result).toMatchObject({ ok: false, reason: "already_decided" });
    expect(h.audit.list()).toHaveLength(0);
  });

  it("refuse une référence action ↔ tâche incohérente", async () => {
    const h = harness({
      agents: [agent("agent-op", 2)],
      tasks: [
        {
          id: "task-x",
          title: "tâche",
          status: "awaiting_approval",
          actionIds: [], // ne référence pas action-x
          createdAt: "2026-07-21T08:00:00.000Z",
          updatedAt: "2026-07-21T08:00:00.000Z",
        },
      ],
      actions: [{ ...pendingSensitive, taskId: "task-x" }],
    });

    const result = await recordActionDecision(h.deps, {
      actionId: "action-x",
      command: { decidedByLabel: "Opérateur", decision: "approved" },
    });

    expect(result).toMatchObject({ ok: false, reason: "inconsistent_reference" });
    expect(await h.approvals.list()).toHaveLength(0);
    expect(h.audit.list()).toHaveLength(0);
  });
});
