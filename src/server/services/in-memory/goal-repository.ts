import { v4 as uuidv4 } from 'uuid';
import { HighLevelGoal, GoalPlanPreview } from "@/core/contracts/high-level-goal";
import type { AuditEntry } from "@/core/contracts";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";
import type { GoalRepository } from "@/server/repositories/ports";

/**
 * In-memory repository for goals to support durability and idempotency.
 */
export class InMemoryGoalRepository implements GoalRepository {
  private readonly auditLog: AuditLog;
  private readonly goals: Map<string, {
    goal: HighLevelGoal;
    preview: GoalPlanPreview;
    status: string;
    convertedAt?: string;
    resultingMissionId?: string;
    idempotencyKey?: string;
  }>;

  constructor(auditLog: AuditLog) {
    this.auditLog = auditLog;
    this.goals = new Map();
  }

  async create(goal: HighLevelGoal, preview: GoalPlanPreview): Promise<void> {
    const now = new Date().toISOString();
    const auditEntry: AuditEntry = {
      id: `audit-${uuidv4()}`,
      occurredAt: now,
      eventType: "goal.created",
      actor: { kind: "system", id: "icos" },
      taskId: undefined,
      actionId: undefined,
      details: { title: goal.title, status: "pending", goalId: goal.id },
      createdAt: now,
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      // If audit fails, we do not persist the goal.
      throw new Error(`Failed to audit goal creation: ${error}`);
    }

    this.goals.set(goal.id, {
      goal,
      preview,
      status: "pending",
      convertedAt: undefined,
      resultingMissionId: undefined,
      idempotencyKey: undefined,
    });
  }

  async getById(goalId: string): Promise<{ goal: HighLevelGoal; preview: GoalPlanPreview } | null> {
    const entry = this.goals.get(goalId);
    if (!entry) {
      return null;
    }
    return {
      goal: entry.goal,
      preview: entry.preview,
    };
  }

  async updateStatus(goalId: string, status: string): Promise<void> {
    const entry = this.goals.get(goalId);
    if (!entry) {
      throw new Error(`Goal not found: ${goalId}`);
    }
    const now = new Date().toISOString();
    entry.status = status;

    const auditEntry: AuditEntry = {
      id: `audit-${uuidv4()}`,
      occurredAt: now,
      eventType: "goal.status_updated",
      actor: { kind: "system", id: "icos" },
      taskId: undefined,
      actionId: undefined,
      details: { status, goalId },
      createdAt: now,
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      throw new Error(`Failed to audit goal status update: ${error}`);
    }
  }

  async setConverted(goalId: string, missionId: string): Promise<void> {
    const entry = this.goals.get(goalId);
    if (!entry) {
      throw new Error(`Goal not found: ${goalId}`);
    }
    const now = new Date().toISOString();
    entry.status = "converted";
    entry.resultingMissionId = missionId;
    entry.convertedAt = now;

    const auditEntry: AuditEntry = {
      id: `audit-${uuidv4()}`,
      occurredAt: now,
      eventType: "goal.converted",
      actor: { kind: "system", id: "icos" },
      taskId: undefined,
      actionId: undefined,
      details: { missionId, goalId },
      createdAt: now,
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      throw new Error(`Failed to audit goal conversion: ${error}`);
    }
  }

  async setIdempotencyKey(goalId: string, idempotencyKey: string): Promise<void> {
    const entry = this.goals.get(goalId);
    if (!entry) {
      throw new Error(`Goal not found: ${goalId}`);
    }
    const now = new Date().toISOString();
    entry.idempotencyKey = idempotencyKey;

    const auditEntry: AuditEntry = {
      id: `audit-${uuidv4()}`,
      occurredAt: now,
      eventType: "goal.idempotency_key_set",
      actor: { kind: "system", id: "icos" },
      taskId: undefined,
      actionId: undefined,
      details: { idempotencyKey, goalId },
      createdAt: now,
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      throw new Error(`Failed to audit idempotency key setting: ${error}`);
    }
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<{ goal: HighLevelGoal; preview: GoalPlanPreview; missionId?: string } | null> {
    for (const [goalId, entry] of this.goals.entries()) {
      if (entry.idempotencyKey === idempotencyKey) {
        return {
          goal: entry.goal,
          preview: entry.preview,
          missionId: entry.resultingMissionId,
        };
      }
    }
    return null;
  }
}