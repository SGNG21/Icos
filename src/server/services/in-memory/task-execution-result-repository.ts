import { randomUUID } from "node:crypto";

import {
  taskExecutionResultSchema,
  type AuditEntry,
  type Task,
  type TaskExecutionResult,
  type TaskStatus,
} from "@/core/contracts";
import { transitionTask as transitionLifecycle } from "@/core/tasks/lifecycle";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";
import type {
  RecordTaskExecutionResultInput,
  RecordTaskExecutionResultOutcome,
  TaskExecutionResultRepository,
} from "@/server/repositories/ports";

/**
 * Accès mutable minimal aux tâches, requis pour appliquer la transition
 * terminale dans la même section critique que l'écriture du résultat.
 * L'implémentation en mémoire des tâches expose ce contrat en interne.
 */
export interface MutableTaskStore {
  find(taskId: string): Task | undefined;
  replace(task: Task): void;
}

/**
 * Repository en mémoire des résultats d'exécution (voir avertissement dans
 * `src/server/audit/in-memory-audit-log.ts`).
 *
 * Mêmes invariants que l'implémentation PostgreSQL :
 * - idempotence par `workflowId` (le rejeu retourne l'enregistrement existant) ;
 * - transition terminale + audit appliqués dans la même section critique
 *   synchrone (aucun `await` entre la validation et les mutations) ;
 * - fail-closed : la validation Zod interdit un échec sans erreur normalisée.
 */
export class InMemoryTaskExecutionResultRepository implements TaskExecutionResultRepository {
  private readonly records: TaskExecutionResult[] = [];

  constructor(
    private readonly auditLog: AuditLog,
    private readonly taskStore: MutableTaskStore,
  ) {}

  async getByTaskId(taskId: string): Promise<TaskExecutionResult | null> {
    const found = this.records.find((record) => record.taskId === taskId);
    return found ? structuredClone(found) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<TaskExecutionResult | null> {
    const found = this.records.find((record) => record.workflowId === workflowId);
    return found ? structuredClone(found) : null;
  }

  async listByTaskIds(taskIds: readonly string[]): Promise<TaskExecutionResult[]> {
    const wanted = new Set(taskIds);
    return this.records
      .filter((record) => wanted.has(record.taskId))
      .map((record) => structuredClone(record));
  }

  async record(input: RecordTaskExecutionResultInput): Promise<RecordTaskExecutionResultOutcome> {
    const existing = this.records.find((record) => record.workflowId === input.workflowId);
    if (existing) {
      const sameResult =
        existing.taskId === input.taskId &&
        existing.outcome === input.outcome &&
        existing.workerKind === input.workerKind &&
        existing.capability === input.capability &&
        existing.digitalosExecutionId === input.digitalosExecutionId &&
        existing.result === input.result &&
        JSON.stringify(existing.error) === JSON.stringify(input.error) &&
        existing.startedAt === input.startedAt &&
        existing.completedAt === input.completedAt &&
        JSON.stringify(existing.artifacts) === JSON.stringify(input.artifacts) &&
        JSON.stringify(existing.evidence) === JSON.stringify(input.evidence) &&
        JSON.stringify(existing.findings) === JSON.stringify(input.findings);

      if (!sameResult) {
        return {
          ok: false,
          reason: "invalid_input",
          message: "résultat conflictuel pour ce workflow",
        };
      }
      return { ok: true, record: structuredClone(existing), duplicate: true };
    }

    const task = this.taskStore.find(input.taskId);
    if (!task) {
      return {
        ok: false,
        reason: "task_not_found",
        message: `tâche inconnue : ${input.taskId}`,
      };
    }

    const now = new Date().toISOString();
    const parsed = taskExecutionResultSchema.safeParse({
      id: `texec-${randomUUID()}`,
      taskId: input.taskId,
      workflowId: input.workflowId,
      outcome: input.outcome,
      workerKind: input.workerKind,
      capability: input.capability,
      digitalosExecutionId: input.digitalosExecutionId,
      result: input.result,
      error: input.error,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      recordedAt: now,
      artifacts: input.artifacts,
      evidence: input.evidence,
      findings: input.findings,
    });
    if (!parsed.success) {
      return { ok: false, reason: "invalid_input", message: parsed.error.message };
    }

    const targetStatus: TaskStatus = "review_pending";
    const transition = transitionLifecycle(task, targetStatus, parsed.data.recordedAt);

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
        statusApplied: transition.ok ? transition.task.status : task.status,
        transitionApplied: transition.ok,
        ...(parsed.data.error ? { errorCode: parsed.data.error.code } : {}),
      },
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    this.records.push(parsed.data);
    if (transition.ok) {
      this.taskStore.replace(transition.task);
    }

    return { ok: true, record: structuredClone(parsed.data), duplicate: false };
  }
}
