import type {
  Agent,
  AgentAction,
  ApprovalStatus,
  Approval,
  AuditEntry,
  Task,
  TaskStatus,
} from "@/core/contracts";
import type { TransitionResult } from "@/core/tasks/lifecycle";

/** Résolution d'existence d'un agent, utilisée pour l'intégrité référentielle. */
export interface AgentLookup {
  getById(id: string): Agent | undefined;
}

export interface AgentService extends AgentLookup {
  list(): readonly Agent[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assignedAgentId?: string;
}

/** Résultat de l'invariant LOCAL de création (schéma + audit). */
export type CreateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "invalid_input" | "audit_failed"; message: string };

export type TransitionTaskResult =
  TransitionResult | { ok: false; reason: "task_not_found" | "audit_failed"; message: string };

export interface TaskService {
  list(): readonly Task[];
  getById(id: string): Task | undefined;
  create(input: CreateTaskInput): CreateTaskResult;
  transition(taskId: string, to: TaskStatus): TransitionTaskResult;
}

export interface ActionQuery {
  approvalStatus?: ApprovalStatus;
}

export interface ActionService {
  list(filter?: ActionQuery): readonly AgentAction[];
  getById(id: string): AgentAction | undefined;
}

export interface ApprovalService {
  list(): readonly Approval[];
  listForAction(actionId: string): readonly Approval[];
}

/**
 * Unité de travail transactionnelle en mémoire pour une décision humaine.
 *
 * Elle applique, comme une opération logique unique, l'enregistrement de
 * l'approbation, la mise à jour de l'action et l'écriture de toutes les entrées
 * d'audit : soit l'ensemble réussit, soit rien n'est appliqué. Elle NE simule
 * PAS une transaction par deux appels de services mutables successifs.
 *
 * PostgreSQL remplacera cette unité de travail par une véritable transaction
 * atomique (roadmap phase 1).
 */
export interface ActionDecisionUnitOfWork {
  commitDecision(input: {
    approval: Approval;
    action: AgentAction;
    auditEntries: readonly AuditEntry[];
  }): CommitDecisionResult;
}

export type CommitDecisionResult =
  | { ok: true; approval: Approval; action: AgentAction }
  | { ok: false; reason: "action_not_found" | "audit_failed"; message: string };
