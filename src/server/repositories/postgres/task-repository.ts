import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";

import { taskSchema, type AuditEntry, type Task, type TaskStatus } from "@/core/contracts";
import { transitionTask as transitionLifecycle } from "@/core/tasks/lifecycle";
import type { Database } from "@/server/database/client";
import { auditToRow, rowToTask, taskToRow } from "@/server/database/mappers";
import { actions, auditEntries, tasks } from "@/server/database/schema";
import type {
  AgentScope,
  CreateTaskInput,
  CreateTaskResult,
  TaskRepository,
  TransitionTaskResult,
} from "@/server/repositories/ports";

/**
 * Repository PostgreSQL des tâches. `Task.actionIds` est dérivé de
 * `actions.task_id` (source unique). Les mutations `create`/`transition`
 * écrivent la ligne et son entrée d'audit dans une **transaction** unique
 * (atomicité tout-ou-rien).
 */
export class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly db: Database) {}

  private async actionIdsFor(taskId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: actions.id })
      .from(actions)
      .where(eq(actions.taskId, taskId))
      .orderBy(asc(actions.createdAt), asc(actions.id));
    return rows.map((row) => row.id);
  }

  private async hydrate(taskRows: (typeof tasks.$inferSelect)[]): Promise<Task[]> {
    if (taskRows.length === 0) {
      return [];
    }

    const actionRows = await this.db
      .select({ id: actions.id, taskId: actions.taskId })
      .from(actions)
      .where(
        inArray(
          actions.taskId,
          taskRows.map((row) => row.id),
        ),
      )
      .orderBy(asc(actions.createdAt), asc(actions.id));

    const byTask = new Map<string, string[]>();
    for (const row of actionRows) {
      if (row.taskId === null) {
        continue;
      }
      const list = byTask.get(row.taskId);
      if (list) {
        list.push(row.id);
      } else {
        byTask.set(row.taskId, [row.id]);
      }
    }

    return taskRows.map((row) => rowToTask(row, byTask.get(row.id) ?? []));
  }

  async list(): Promise<Task[]> {
    // Ordre déterministe : created_at ASC, id ASC.
    const taskRows = await this.db
      .select()
      .from(tasks)
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    return this.hydrate(taskRows);
  }

  async listForScope(scope: AgentScope): Promise<Task[]> {
    if (scope.kind === "global") {
      return this.list();
    }

    const agentIds = [...scope.agentIds];
    if (agentIds.length === 0) {
      return [];
    }

    const taskRows = await this.db
      .select()
      .from(tasks)
      .where(inArray(tasks.assignedAgentId, agentIds))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    return this.hydrate(taskRows);
  }

  async getById(id: string): Promise<Task | null> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!rows[0]) {
      return null;
    }
    return rowToTask(rows[0], await this.actionIdsFor(id));
  }

  async getByIdForScope(id: string, scope: AgentScope): Promise<Task | null> {
    const rows =
      scope.kind === "global"
        ? await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
        : scope.agentIds.size === 0
          ? []
          : await this.db
              .select()
              .from(tasks)
              .where(and(eq(tasks.id, id), inArray(tasks.assignedAgentId, [...scope.agentIds])))
              .limit(1);

    if (!rows[0]) {
      return null;
    }
    return rowToTask(rows[0], await this.actionIdsFor(id));
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

    await this.db.transaction(async (tx) => {
      await tx.insert(tasks).values(taskToRow(parsed.data));
      await tx.insert(auditEntries).values(auditToRow(auditEntry));
    });

    return { ok: true, task: parsed.data };
  }

  async transition(taskId: string, to: TaskStatus): Promise<TransitionTaskResult> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!rows[0]) {
      return { ok: false, reason: "task_not_found", message: `tâche inconnue : ${taskId}` };
    }

    const current = rowToTask(rows[0], await this.actionIdsFor(taskId));
    const result = transitionLifecycle(current, to);
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

    await this.db.transaction(async (tx) => {
      await tx
        .update(tasks)
        .set({ status: result.task.status, updatedAt: new Date(result.task.updatedAt) })
        .where(eq(tasks.id, taskId));
      await tx.insert(auditEntries).values(auditToRow(auditEntry));
    });

    return { ok: true, task: result.task };
  }
}
