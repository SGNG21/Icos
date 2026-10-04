import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";

import {
  taskExecutionResultSchema,
  type AuditEntry,
  type TaskExecutionResult,
  type TaskStatus,
} from "@/core/contracts";
import { transitionTask as transitionLifecycle } from "@/core/tasks/lifecycle";
import type { Database } from "@/server/database/client";
import {
  auditToRow,
  rowToTask,
  rowToTaskExecutionResult,
  taskExecutionResultToRow,
} from "@/server/database/mappers";
import { auditEntries, taskExecutionResults, tasks } from "@/server/database/schema";
import type {
  RecordTaskExecutionResultInput,
  RecordTaskExecutionResultOutcome,
  TaskExecutionResultRepository,
} from "@/server/repositories/ports";

/**
 * Repository PostgreSQL des résultats d'exécution (preuve métier canonique).
 *
 * INVARIANTS :
 * - idempotence portée par la contrainte UNIQUE `workflow_id` : le rejeu d'un
 *   même callback Temporal retourne l'enregistrement existant sans doublon ni
 *   écrasement ;
 * - atomicité : l'écriture du résultat, la transition de statut de la tâche et
 *   l'entrée d'audit se font dans une transaction unique ;
 * - fail-closed : un `outcome` d'échec exige une erreur normalisée (contrainte
 *   Zod + CHECK SQL) ; aucun `succeeded` implicite n'est possible ;
 * - AUCUN appel externe (worker, modèle, HTTP) n'est effectué ici : la
 *   transaction reste courte et déterministe.
 */
export class PostgresTaskExecutionResultRepository implements TaskExecutionResultRepository {
  constructor(private readonly db: Database) {}

  async getByTaskId(taskId: string): Promise<TaskExecutionResult | null> {
    const rows = await this.db
      .select()
      .from(taskExecutionResults)
      .where(eq(taskExecutionResults.taskId, taskId))
      .orderBy(asc(taskExecutionResults.recordedAt), asc(taskExecutionResults.id))
      .limit(1);
    return rows[0] ? rowToTaskExecutionResult(rows[0]) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<TaskExecutionResult | null> {
    const rows = await this.db
      .select()
      .from(taskExecutionResults)
      .where(eq(taskExecutionResults.workflowId, workflowId))
      .limit(1);
    return rows[0] ? rowToTaskExecutionResult(rows[0]) : null;
  }

  async listByTaskIds(taskIds: readonly string[]): Promise<TaskExecutionResult[]> {
    if (taskIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .select()
      .from(taskExecutionResults)
      .where(inArray(taskExecutionResults.taskId, [...taskIds]))
      .orderBy(asc(taskExecutionResults.recordedAt), asc(taskExecutionResults.id));
    return rows.map(rowToTaskExecutionResult);
  }

  async record(input: RecordTaskExecutionResultInput): Promise<RecordTaskExecutionResultOutcome> {
    // Court-circuit idempotent AVANT toute écriture : un rejeu n'ouvre même pas
    // de transaction.
    const existing = await this.getByWorkflowId(input.workflowId);
    if (existing) {
      const sameResult = this.matchesInput(existing, input);

      if (!sameResult) {
        return {
          ok: false,
          reason: "invalid_input",
          message: "résultat conflictuel pour ce workflow",
        };
      }
      return { ok: true, record: existing, duplicate: true };
    }

    const now = new Date().toISOString();
    const candidate = {
      id: `texec-${randomUUID()}`,
      taskId: input.taskId,
      workflowId: input.workflowId,
      outcome: input.outcome,
      workerKind: input.workerKind,
      capability: input.capability,
      digitalosExecutionId: input.digitalosExecutionId,
      actualExecutor: input.actualExecutor,
      actualProvider: input.actualProvider,
      actualModel: input.actualModel,
      result: input.result,
      error: input.error,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      recordedAt: now,
      artifacts: input.artifacts,
      evidence: input.evidence,
      findings: input.findings,
    };

    const parsed = taskExecutionResultSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_input", message: parsed.error.message };
    }

    const targetStatus: TaskStatus = "review_pending";

    try {
      return await this.db.transaction(async (tx) => {
        const taskRows = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .limit(1)
          .for("update");

        if (!taskRows[0]) {
          return {
            ok: false as const,
            reason: "task_not_found" as const,
            message: `tâche inconnue : ${input.taskId}`,
          };
        }

        const current = rowToTask(taskRows[0], []);

        const insertRow = taskExecutionResultToRow(parsed.data);
        await tx.insert(taskExecutionResults).values(insertRow);

        // La tâche peut déjà être terminale (annulation concurrente) : la preuve
        // est conservée, mais aucune transition impossible n'est forcée.
        const transition = transitionLifecycle(current, targetStatus, parsed.data.recordedAt);
        if (transition.ok) {
          await tx
            .update(tasks)
            .set({
              status: transition.task.status,
              updatedAt: new Date(transition.task.updatedAt),
            })
            .where(eq(tasks.id, input.taskId));
        }

        const auditEntry: AuditEntry = {
          id: `audit-${randomUUID()}`,
          occurredAt: parsed.data.recordedAt,
          createdAt: parsed.data.recordedAt,
          eventType: "task.execution.completed",
          actor: { kind: "system", id: "icos" },
          taskId: input.taskId,
          details: {
            workflowId: parsed.data.workflowId,
            outcome: parsed.data.outcome,
            statusApplied: transition.ok ? transition.task.status : current.status,
            transitionApplied: transition.ok,
            ...(parsed.data.error ? { errorCode: parsed.data.error.code } : {}),
          },
        };
        await tx.insert(auditEntries).values(auditToRow(auditEntry));

        return { ok: true as const, record: parsed.data, duplicate: false };
      });
    } catch (error) {
      // Course concurrente sur la contrainte UNIQUE : le premier écrivain a
      // gagné, son enregistrement fait foi.
      const raced = await this.getByWorkflowId(input.workflowId);
      if (raced) {
        if (!this.matchesInput(raced, input)) {
          return {
            ok: false,
            reason: "invalid_input",
            message: "résultat conflictuel pour ce workflow",
          };
        }
        return { ok: true, record: raced, duplicate: true };
      }
      throw error;
    }
  }

  private matchesInput(
    existing: TaskExecutionResult,
    input: RecordTaskExecutionResultInput,
  ): boolean {
    return (
      existing.taskId === input.taskId &&
      existing.outcome === input.outcome &&
      existing.workerKind === input.workerKind &&
      existing.capability === input.capability &&
      existing.digitalosExecutionId === input.digitalosExecutionId &&
      existing.result === input.result &&
      existing.startedAt === input.startedAt &&
      existing.completedAt === input.completedAt &&
      JSON.stringify(existing.error) === JSON.stringify(input.error) &&
      JSON.stringify(existing.artifacts) === JSON.stringify(input.artifacts) &&
      JSON.stringify(existing.evidence) === JSON.stringify(input.evidence) &&
      JSON.stringify(existing.findings) === JSON.stringify(input.findings)
    );
  }
}
