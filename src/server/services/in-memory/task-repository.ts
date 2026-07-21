import { randomUUID } from "node:crypto";

import { taskSchema, type AuditEntry, type Task, type TaskStatus } from "@/core/contracts";
import { transitionTask } from "@/core/tasks/lifecycle";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";
import type {
  CreateTaskInput,
  CreateTaskResult,
  TaskRepository,
  TransitionTaskResult,
} from "@/server/repositories/ports";

/**
 * Repository en mémoire des tâches (voir avertissement dans
 * `src/server/audit/in-memory-audit-log.ts`).
 *
 * Chaque mutation suit l'ordre : valider la commande, préparer le nouvel état,
 * écrire l'audit, puis appliquer la mutation ; si l'audit échoue, la mutation
 * n'est pas appliquée. Les méthodes sont `async` (port), mais leur corps ne
 * contient aucun `await` : l'écriture d'audit (journal SYNCHRONE interne) et la
 * mutation restent atomiques au sein d'une instance JavaScript.
 */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks: Task[];

  constructor(
    private readonly auditLog: AuditLog,
    seed: readonly Task[] = [],
  ) {
    this.tasks = seed.map((task) => taskSchema.parse(structuredClone(task)));
  }

  async list(): Promise<Task[]> {
    return this.tasks.map((task) => structuredClone(task));
  }

  async getById(id: string): Promise<Task | null> {
    const task = this.tasks.find((candidate) => candidate.id === id);
    return task ? structuredClone(task) : null;
  }

  async create(input: CreateTaskInput): Promise<CreateTaskResult> {
    const now = new Date().toISOString();
    const candidate: Task = {
      id: `task-${randomUUID()}`,
      title: input.title,
      description: input.description,
      assignedAgentId: input.assignedAgentId,
      status: "draft",
      actionIds: [],
      createdAt: now,
      updatedAt: now,
    };

    const parsed = taskSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_input", message: parsed.error.message };
    }

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "task.created",
      actor: input.assignedAgentId
        ? { kind: "agent", id: input.assignedAgentId }
        : { kind: "system", id: "icos" },
      taskId: parsed.data.id,
      details: { title: parsed.data.title, status: parsed.data.status },
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      return { ok: false, reason: "audit_failed", message: describeError(error) };
    }

    this.tasks.push(parsed.data);
    return { ok: true, task: structuredClone(parsed.data) };
  }

  async transition(taskId: string, to: TaskStatus): Promise<TransitionTaskResult> {
    const index = this.tasks.findIndex((candidate) => candidate.id === taskId);
    if (index === -1) {
      return { ok: false, reason: "task_not_found", message: `tâche inconnue : ${taskId}` };
    }

    const current = this.tasks[index];
    const result = transitionTask(current, to);
    if (!result.ok) {
      return result;
    }

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: result.task.updatedAt,
      eventType: "task.transitioned",
      actor: current.assignedAgentId
        ? { kind: "agent", id: current.assignedAgentId }
        : { kind: "system", id: "icos" },
      taskId: current.id,
      details: { from: current.status, to },
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      return { ok: false, reason: "audit_failed", message: describeError(error) };
    }

    this.tasks[index] = result.task;
    return { ok: true, task: structuredClone(result.task) };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
