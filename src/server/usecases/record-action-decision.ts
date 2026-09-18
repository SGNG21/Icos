import { randomUUID } from "node:crypto";

import type {
  ActionDecisionCommand,
  AgentAction,
  Approval,
  AuditEntry,
  Agent,
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

export async function recordActionDecision(
  deps: RecordActionDecisionDeps,
  { actionId, command }: { actionId: string; command: ActionDecisionCommand }
): Promise<RecordActionDecisionResult> {
  const {
    actions,
    agents,
    tasks,
    uow,
    now = () => new Date().toISOString(),
    newId = (prefix: string) => `${prefix}-${Math.random()}`,
  } = deps;

  // 1. Get the action
  const action = await actions.getById(actionId);
  if (!action) {
    return { ok: false, reason: "action_not_found", message: "action not found" };
  }

  // 2. Check if already decided
  if (action.approvalStatus !== "pending") {
    return { ok: false, reason: "already_decided", message: "action already decided" };
  }

  // 3. Get the initiator agent
  const initiator = await agents.getById(action.initiatedByAgentId);
  if (!initiator) {
    return { ok: false, reason: "agent_not_found", message: "agent not found" };
  }

  // 4. Check task consistency if taskId exists
  if (action.taskId) {
    const task = await tasks.getById(action.taskId);
    if (!task) {
      return { ok: false, reason: "inconsistent_reference", message: "task not found" };
    }
    if (!task.actionIds.includes(action.id)) {
      return { ok: false, reason: "inconsistent_reference", message: "action not in task" };
    }
  }

  // 5. Create approval
  const approvalId = newId("approval");
  const timestamp = now();
  const approval: Approval = {
    id: approvalId,
    actionId: action.id,
    decision: command.decision,
    decidedBy: command.decidedByLabel,
    reason: command.reason ?? undefined,
    decidedAt: timestamp,
  };

  // Update the action's approvalStatus to the decision
  action.approvalStatus = command.decision;

  // 6. Create audit entries
  const auditEntries: readonly AuditEntry[] = [
    {
      id: newId("audit"),
      eventType: "approval.recorded",
      actor: { kind: "agent", id: initiator.id },
      taskId: action.taskId ?? undefined,
      actionId: action.id,
      details: {},
      occurredAt: timestamp,
      createdAt: timestamp,
    },
    {
      id: newId("audit"),
      eventType: "action.decided",
      actor: { kind: "agent", id: initiator.id },
      taskId: action.taskId ?? undefined,
      actionId: action.id,
      details: command.reason
        ? { decision: command.decision, reason: command.reason }
        : { decision: command.decision },
      occurredAt: timestamp,
      createdAt: timestamp,
    },
  ];

  // 7. Commit via uow
  const uowResult = await uow.commitDecision({ approval, action, auditEntries });
  if (!uowResult.ok) {
    // Map the uow error to our result
    let reason: "action_not_found" | "already_decided" | "audit_failed" = "audit_failed";
    switch (uowResult.reason) {
      case "action_not_found":
        reason = "action_not_found";
        break;
      case "already_decided":
        reason = "already_decided";
        break;
      default:
        reason = "audit_failed";
    }
    return { ok: false, reason, message: uowResult.message };
  }

  // 8. Return the uow result with execution decision
  const execution = decideExecution(action, initiator);
  return { ok: true, approval, action, execution };
}