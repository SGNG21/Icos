import { randomUUID } from "node:crypto";

import type {
  ActionDecisionCommand,
  AgentAction,
  Approval,
  AuditEntry,
  Task,
} from "@/core/contracts";
import { decideExecution, type ExecutionDecision } from "@/core/authorization/decide";
import type { ActionRepository, AgentLookup } from "@/server/repositories/ports";
import type { ActionDecisionUnitOfWork } from "@/server/uow/ports";

export interface TaskLookup {
  getById(id: string): Promise<Task | null>;
}

export interface RecordActionDecisionDeps {
  actions: ActionRepository;
  agents: AgentLookup;
  tasks: TaskLookup;
  uow: ActionDecisionUnitOfWork;
  now?: () => string;
  newId?: (prefix: string) => string;
}

export type RecordActionDecisionResult =
  | { ok: true; approval: Approval; action: AgentAction; execution: ExecutionDecision }
  | {
      ok: false;
      reason:
        | "action_not_found"
        | "already_decided"
        | "agent_not_found"
        | "inconsistent_reference"
        | "audit_failed";
      message: string;
    };

/**
 * Orchestration d'une décision humaine sur une action, dans l'ordre imposé :
 * l'agent initiateur est résolu et toutes les références sont vérifiées AVANT
 * toute mutation. L'écriture (approbation + action + audit) est confiée à
 * l'unité de travail transactionnelle. `decideExecution` est appelé en dernier,
 * avec l'action mise à jour et l'agent RÉSOLU côté serveur — jamais un agent ou
 * un niveau fourni par l'appelant.
 */
export async function recordActionDecision(
  deps: RecordActionDecisionDeps,
  input: { actionId: string; command: ActionDecisionCommand },
): Promise<RecordActionDecisionResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const { actionId, command } = input;

  // 2. charger l'action
  const action = await deps.actions.getById(actionId);
  if (!action) {
    return { ok: false, reason: "action_not_found", message: `action introuvable : ${actionId}` };
  }

  // 3. vérifier son état : une décision définitive ne peut pas être rejouée
  if (action.approvalStatus === "approved" || action.approvalStatus === "rejected") {
    return {
      ok: false,
      reason: "already_decided",
      message: `l'action ${actionId} a déjà reçu une décision définitive`,
    };
  }

  // 4. résoudre l'agent depuis l'action, AVANT toute mutation
  const agent = await deps.agents.getById(action.initiatedByAgentId);
  if (!agent) {
    return {
      ok: false,
      reason: "agent_not_found",
      message: `agent initiateur introuvable : ${action.initiatedByAgentId}`,
    };
  }

  // 5. vérifier les références liées (cohérence bidirectionnelle action ↔ tâche)
  if (action.taskId !== undefined) {
    const task = await deps.tasks.getById(action.taskId);
    if (!task || !task.actionIds.includes(action.id)) {
      return {
        ok: false,
        reason: "inconsistent_reference",
        message: `incohérence action ↔ tâche pour ${action.id}`,
      };
    }
  }

  // 6. préparer la décision (approbation, action mise à jour, entrées d'audit)
  const at = now();
  const nextStatus = command.decision === "approved" ? "approved" : "rejected";
  const updatedAction: AgentAction = { ...action, approvalStatus: nextStatus };

  const approval: Approval = {
    id: newId("approval"),
    actionId: action.id,
    decidedBy: command.decidedByLabel,
    decision: command.decision,
    reason: command.reason,
    decidedAt: at,
  };

  const auditEntries: AuditEntry[] = [
    {
      id: newId("audit"),
      occurredAt: at,
      eventType: "approval.recorded",
      actor: { kind: "human", id: command.decidedByLabel },
      actionId: action.id,
      taskId: action.taskId,
      details: { decision: command.decision, reason: command.reason ?? null },
    },
    {
      id: newId("audit"),
      occurredAt: at,
      eventType: "action.decided",
      actor: { kind: "human", id: command.decidedByLabel },
      actionId: action.id,
      taskId: action.taskId,
      details: { previousStatus: action.approvalStatus, approvalStatus: nextStatus },
    },
  ];

  // 7. appliquer la transaction simulée
  const committed = await deps.uow.commitDecision({
    approval,
    action: updatedAction,
    auditEntries,
  });
  if (!committed.ok) {
    return { ok: false, reason: committed.reason, message: committed.message };
  }

  // 8. décision d'exécution avec l'action à jour et l'agent résolu
  const execution = decideExecution(committed.action, agent);

  // 9. résultat métier
  return { ok: true, approval: committed.approval, action: committed.action, execution };
}
