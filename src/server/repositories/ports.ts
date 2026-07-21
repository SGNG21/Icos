import type {
  Agent,
  AgentAction,
  ApprovalStatus,
  Approval,
  AuditEntry,
  Task,
  TaskStatus,
} from "@/core/contracts";
import type { AuditQuery } from "@/server/audit/in-memory-audit-log";
import type { TransitionResult } from "@/core/tasks/lifecycle";

/**
 * Ports d'accès aux entités (repositories). Toutes les opérations sont
 * asynchrones : une implémentation PostgreSQL (Lot 2A-2) satisfera les mêmes
 * ports. Les implémentations in-memory renvoient des `Promise` résolues.
 *
 * Convention : une ressource absente est représentée par `null` (jamais
 * `undefined`), de façon uniforme sur tous les repositories.
 */

/** Résolution d'existence d'un agent, utilisée pour l'intégrité référentielle. */
export interface AgentLookup {
  getById(id: string): Promise<Agent | null>;
}

export interface AgentRepository extends AgentLookup {
  list(): Promise<Agent[]>;
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

export interface TaskRepository {
  list(): Promise<Task[]>;
  getById(id: string): Promise<Task | null>;
  create(input: CreateTaskInput): Promise<CreateTaskResult>;
  transition(taskId: string, to: TaskStatus): Promise<TransitionTaskResult>;
}

export interface ActionQuery {
  approvalStatus?: ApprovalStatus;
}

export interface ActionRepository {
  list(filter?: ActionQuery): Promise<AgentAction[]>;
  getById(id: string): Promise<AgentAction | null>;
}

export interface ApprovalRepository {
  list(): Promise<Approval[]>;
  listForAction(actionId: string): Promise<Approval[]>;
}

export interface AuditRepository {
  append(entry: AuditEntry): Promise<AuditEntry>;
  appendMany(entries: readonly AuditEntry[]): Promise<AuditEntry[]>;
  list(): Promise<AuditEntry[]>;
  query(filter: AuditQuery): Promise<AuditEntry[]>;
}
