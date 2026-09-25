import { randomUUID } from "node:crypto";

import {
  taskSchema,
  type AuditEntry,
  type Task,
} from "@/core/contracts";

import type {
  CreateTaskInput,
  CreateTaskResult,
} from "@/server/repositories/ports";

export type PreparedTaskCreation =
  | {
      ok: true;
      task: Task;
      auditEntry: AuditEntry;
    }
  | Extract<CreateTaskResult, { ok: false }>;

/**
 * Builds and validates a canonical Task and its mandatory creation audit.
 *
 * Pure with respect to persistence:
 * - generates identifiers/timestamps
 * - validates the Task domain contract
 * - performs NO database write
 *
 * The caller owns the transaction in which Task + audit are persisted.
 */
export function prepareTaskCreation(
  input: CreateTaskInput,
): PreparedTaskCreation {
  const now = new Date().toISOString();

  const candidate: Task = {
    id: `task-${randomUUID()}`,
    title: input.title,
    description: input.description,
    missionId: input.missionId,
    goalId: input.goalId,
    planId: input.planId,
    objective: input.objective,
    instructions: input.instructions,
    dependencies: input.dependencies ?? [],
    successCriteria: input.successCriteria ?? [],
    requiredCapabilities: input.requiredCapabilities ?? [],
    riskClass: input.riskClass,
    allowedFileScope: input.allowedFileScope ?? [],
    expectedArtifacts: input.expectedArtifacts ?? [],
    priority: input.priority,
    attemptBudget: input.attemptBudget,
    reviewPolicy: input.reviewPolicy,
    integrationPolicy: input.integrationPolicy,
    assignedAgentId: input.assignedAgentId,
    status: "draft",
    actionIds: [],
    createdAt: now,
    updatedAt: now,
  };

  const parsed = taskSchema.safeParse(candidate);

  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: parsed.error.message,
    };
  }

  const auditEntry: AuditEntry = {
    id: `audit-${randomUUID()}`,
    occurredAt: now,
    eventType: "task.created",
    actor: input.assignedAgentId
      ? { kind: "agent", id: input.assignedAgentId }
      : { kind: "system", id: "icos" },
    taskId: parsed.data.id,
    details: {
      title: parsed.data.title,
      status: parsed.data.status,
    },
    createdAt: now,
  };

  return {
    ok: true,
    task: parsed.data,
    auditEntry,
  };
}