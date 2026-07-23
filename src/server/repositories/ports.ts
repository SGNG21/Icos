import type {
  Agent,
  AgentAction,
  Approval,
  ApprovalStatus,
  AuditEntry,
  Task,
  TaskStatus,
} from "@/core/contracts";
import type { HumanAgentLink, Role, UserStatus } from "@/core/identity";
import type { TransitionResult } from "@/core/tasks/lifecycle";
import type { AuditQuery } from "@/server/audit/in-memory-audit-log";

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

export interface AdminHumanUser {
  id: string;
  email: string;
  name?: string;
  status: UserStatus;
  role: Role | null;
}

export type AgentScope =
  | { kind: "global" }
  | {
      kind: "linked";
      agentIds: ReadonlySet<string>;
    };

export interface HumanUserAdministrationRepository {
  list(): Promise<AdminHumanUser[]>;
  findById(id: string): Promise<AdminHumanUser | null>;
  findByEmail(email: string): Promise<AdminHumanUser | null>;
}

export interface HumanAgentLinkRepository {
  listForHuman(humanUserId: string): Promise<HumanAgentLink[]>;
  listAgentIdsForHuman(humanUserId: string): Promise<ReadonlySet<string>>;
}

export interface AgentRepository extends AgentLookup {
  list(): Promise<Agent[]>;
  listForScope(scope: AgentScope): Promise<Agent[]>;
  getByIdForScope(id: string, scope: AgentScope): Promise<Agent | null>;
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
  listForScope(scope: AgentScope): Promise<Task[]>;
  getById(id: string): Promise<Task | null>;
  getByIdForScope(id: string, scope: AgentScope): Promise<Task | null>;
  create(input: CreateTaskInput): Promise<CreateTaskResult>;
  transition(taskId: string, to: TaskStatus): Promise<TransitionTaskResult>;
}

export interface ActionQuery {
  approvalStatus?: ApprovalStatus;
}

export interface ActionRepository {
  list(filter?: ActionQuery): Promise<AgentAction[]>;
  listForScope(scope: AgentScope, filter?: ActionQuery): Promise<AgentAction[]>;
  getById(id: string): Promise<AgentAction | null>;
  getByIdForScope(id: string, scope: AgentScope): Promise<AgentAction | null>;
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
