import { and, eq } from "drizzle-orm";

import type { HighLevelGoal, GoalPlanPreview } from "@/core/contracts/high-level-goal";
import type { Database } from "@/server/database/client";
import type { GoalRepository } from "@/server/repositories/ports";
import { auditEntries, goals, goalPreviews } from "@/server/database/schema";
import { auditToRow, rowToGoal, goalToRow, goalPreviewToRow, rowToGoalPreview } from "@/server/database/mappers";

/**
 * Repository PostgreSQL des objectifs.
 */
export class PostgresGoalRepository implements GoalRepository {
  constructor(private readonly db: Database) {}

  async create(goal: HighLevelGoal, preview: GoalPlanPreview): Promise<void> {
    const nowDate = new Date();
    const nowISO = nowDate.toISOString();

    // Build and validate the goal and preview before opening the transaction.
    const goalRow = goalToRow(goal);
    const previewRow = goalPreviewToRow(preview);

    // We'll create an audit entry for goal creation.
    const auditEntry = {
      id: crypto.randomUUID(),
      eventType: "goal.created" as const,
      actor: { kind: "system", id: "icos" } as const,
      taskId: undefined,
      actionId: undefined,
      details: { title: goal.title, status: "pending", goalId: goal.id },
      occurredAt: nowISO,
      createdAt: nowISO,
    } as const;
    await this.db.transaction(async (tx) => {
      await tx.insert(goals).values(goalRow);
      await tx.insert(goalPreviews).values(previewRow);
      await tx.insert(auditEntries).values(auditToRow(auditEntry));
    });
  }

  async getById(goalId: string): Promise<{ goal: HighLevelGoal; preview: GoalPlanPreview } | null> {
    const result = await this.db
      .select({ goal: goals, preview: goalPreviews })
      .from(goals)
      .innerJoin(goalPreviews, eq(goals.id, goalPreviews.goalId))
      .where(eq(goals.id, goalId))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return {
      goal: rowToGoal(result[0].goal),
      preview: rowToGoalPreview(result[0].preview),
    };
  }

  async updateStatus(goalId: string, status: string): Promise<void> {
    const nowDate = new Date();
    const nowISO = nowDate.toISOString();
    const auditEntry = {
      id: crypto.randomUUID(),
      eventType: "goal.status_updated" as const,
      actor: { kind: "system", id: "icos" } as const,
      taskId: undefined,
      actionId: undefined,
      details: { status, goalId },
      occurredAt: nowISO,
      createdAt: nowISO,
    } as const;
    await this.db.transaction(async (tx) => {
      await tx
        .update(goals)
        .set({ status, updatedAt: nowDate })
        .where(eq(goals.id, goalId));

      await tx.insert(auditEntries).values(auditToRow(auditEntry));
    });
  }

  async setConverted(goalId: string, missionId: string): Promise<void> {
    const nowDate = new Date();
    const nowISO = nowDate.toISOString();
    const auditEntry = {
      id: crypto.randomUUID(),
      eventType: "goal.converted" as const,
      actor: { kind: "system", id: "icos" } as const,
      taskId: undefined,
      actionId: undefined,
      details: { missionId, goalId },
      occurredAt: nowISO,
      createdAt: nowISO,
    } as const;
    await this.db.transaction(async (tx) => {
      await tx
        .update(goals)
        .set({ status: "converted", updatedAt: nowDate })
        .where(eq(goals.id, goalId));

      await tx.insert(auditEntries).values(auditToRow(auditEntry));
    });
  }

  async setIdempotencyKey(goalId: string, idempotencyKey: string): Promise<void> {
    const nowDate = new Date();
    const nowISO = nowDate.toISOString();
    const auditEntry = {
      id: crypto.randomUUID(),
      eventType: "goal.idempotency_key_set" as const,
      actor: { kind: "system", id: "icos" } as const,
      taskId: undefined,
      actionId: undefined,
      details: { idempotencyKey },
      occurredAt: nowISO,
      createdAt: nowISO,
    } as const;
    await this.db.transaction(async (tx) => {
      await tx
        .update(goals)
        .set({ status: "converted", updatedAt: nowDate })
        .where(eq(goals.id, goalId));

      await tx.insert(auditEntries).values(auditToRow(auditEntry));
    });
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<{ goal: HighLevelGoal; preview: GoalPlanPreview; missionId?: string } | null> {
    const result = await this.db
      .select({
        goal: goals,
        preview: goalPreviews,
        missionId: goals.resultingMissionId,
      })
      .from(goals)
      .innerJoin(goalPreviews, eq(goals.id, goalPreviews.goalId))
      .where(eq(goals.idempotencyKey, idempotencyKey))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return {
      goal: rowToGoal(result[0].goal),
      preview: rowToGoalPreview(result[0].preview),
      missionId: result[0].missionId ?? undefined,
    };
  }
}