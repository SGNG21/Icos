import type { Agent, Approval, ApprovalDecision, Task, TaskStatus } from "@/core/contracts";
import type { TransitionResult } from "@/core/tasks/lifecycle";

export interface AgentService {
  list(): readonly Agent[];
  getById(id: string): Agent | undefined;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assignedAgentId?: string;
}

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

export interface RecordApprovalInput {
  actionId: string;
  decidedBy: string;
  decision: ApprovalDecision;
  reason?: string;
}

export type RecordApprovalResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "invalid_input" | "audit_failed"; message: string };

export interface ApprovalService {
  list(): readonly Approval[];
  listForAction(actionId: string): readonly Approval[];
  recordDecision(input: RecordApprovalInput): RecordApprovalResult;
}
