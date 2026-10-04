import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";

import type { Database } from "@/server/database/client";
import { missions, missionTasks, tasks } from "@/server/database/schema";
import type { MissionRepository } from "@/server/mission/ports";
import type { Mission, MissionTask } from "@/core/mission/contracts";

export class PostgresMissionRepository implements MissionRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    title: string;
    objective: string;
    tasks: Omit<MissionTask, "id" | "missionId" | "status" | "taskId">[];
  }): Promise<Mission> {
    const missionId = randomUUID();
    const now = new Date();

    return await this.db.transaction(async (tx) => {
      await tx.insert(missions).values({
        id: missionId,
        title: input.title,
        objective: input.objective,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });

      // We'll create tasks and missionTasks together
      const missionTaskIds: string[] = [];
      for (let i = 0; i < input.tasks.length; i++) {
        const taskInput = input.tasks[i];
        const missionTaskId = randomUUID();
        const taskId = missionTaskId; // reuse same UUID for canonical task
        await tx.insert(tasks).values({
          id: taskId,
          title: taskInput.title,
          description: taskInput.description ?? null,
          status: "draft",
          assignedAgentId: null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(missionTasks).values({
          id: missionTaskId,
          missionId: missionId,
          title: taskInput.title,
          description: taskInput.description ?? null,
          status: "draft",
          workerKind: taskInput.workerKind,
          capability: taskInput.capability,
          taskId: taskId,
          createdAt: now,
          updatedAt: now,
        });
        missionTaskIds.push(missionTaskId);
      }

      // Now update dependsOn for each missionTask based on input.dependsOn
      // input.dependsOn are expected to be missionTask ids (as strings) referencing other missionTasks in the same mission
      for (let i = 0; i < input.tasks.length; i++) {
        const dependsOn = input.tasks[i].dependsOn ?? [];
        // Convert dependsOn array to JSONB string
        await tx
          .update(missionTasks)
          .set({ dependsOn: dependsOn })
          .where(eq(missionTasks.id, missionTaskIds[i]));
      }

      return {
        id: missionId,
        title: input.title,
        objective: input.objective,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  async applyPlan(
    _missionId: string,
    _plan: import("@/server/mission/mission-plan").MissionPlan,
  ): Promise<
    import("@/core/mission/contracts").MissionTask[]
  > {
    throw new Error(
      "MISSION_PLAN_UNSUPPORTED_LEGACY_REPOSITORY",
    );
  }

  async findById(id: string): Promise<Mission | null> {
    const rows = await this.db.select().from(missions).where(eq(missions.id, id));
    if (rows.length === 0) return null;
    const m = rows[0];
    return {
      id: m.id,
      title: m.title,
      objective: m.objective,
      status: m.status as Mission["status"],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  async findByGoalId(goalId: string): Promise<Mission | null> {
    const rows = await this.db.select().from(missions).where(eq(missions.goalId, goalId));
    if (rows.length === 0) return null;
    const m = rows[0];
    return {
      id: m.id,
      title: m.title,
      objective: m.objective,
      status: m.status as Mission["status"],
      goalId: m.goalId ?? undefined,
      planId: m.planId ?? undefined,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  async listTasks(missionId: string): Promise<MissionTask[]> {
    const rows = await this.db
      .select({
        id: missionTasks.id,
        missionId: missionTasks.missionId,
        title: missionTasks.title,
        description: missionTasks.description,
        dependsOn: missionTasks.dependsOn,
        status: missionTasks.status,
        workerKind: missionTasks.workerKind,
        capability: missionTasks.capability,
        taskId: missionTasks.taskId,
      })
      .from(missionTasks)
      .where(eq(missionTasks.missionId, missionId));
    return rows.map((t) => ({
      id: t.id,
      missionId: t.missionId,
      title: t.title,
      description: t.description,
      dependsOn: t.dependsOn as string[],
      status: t.status as MissionTask["status"],
      workerKind: t.workerKind,
      capability: t.capability,
      taskId: t.taskId,
    }));
  }

  async getMissionIdByTaskId(taskId: string): Promise<string | null> {
    const rows = await this.db
      .select({ missionId: missionTasks.missionId })
      .from(missionTasks)
      .where(eq(missionTasks.id, taskId))
      .limit(1);
    return rows.length > 0 ? rows[0].missionId : null;
  }

  async getMissionTaskById(taskId: string): Promise<MissionTask | null> {
    const rows = await this.db
      .select({
        id: missionTasks.id,
        missionId: missionTasks.missionId,
        title: missionTasks.title,
        description: missionTasks.description,
        dependsOn: missionTasks.dependsOn,
        status: missionTasks.status,
        workerKind: missionTasks.workerKind,
        taskId: missionTasks.taskId,
      })
      .from(missionTasks)
      .where(eq(missionTasks.id, taskId))
      .limit(1);
    if (rows.length === 0) return null;
    const t = rows[0];
    return {
      id: t.id,
      missionId: t.missionId,
      title: t.title,
      description: t.description,
      dependsOn: t.dependsOn as string[],
      status: t.status as MissionTask["status"],
      workerKind: t.workerKind,
      taskId: t.taskId,
    };
  }

  async getMissionTaskByCanonicalTaskId(canonicalTaskId: string): Promise<MissionTask | null> {
    // Lookup missionTask by its taskId (canonical task id)
    const rows = await this.db
      .select({
        id: missionTasks.id,
        missionId: missionTasks.missionId,
        title: missionTasks.title,
        description: missionTasks.description,
        dependsOn: missionTasks.dependsOn,
        status: missionTasks.status,
        workerKind: missionTasks.workerKind,
        taskId: missionTasks.taskId,
      })
      .from(missionTasks)
      .where(eq(missionTasks.taskId, canonicalTaskId))
      .limit(1);
    if (rows.length === 0) return null;
    const t = rows[0];
    return {
      id: t.id,
      missionId: t.missionId,
      title: t.title,
      description: t.description,
      dependsOn: t.dependsOn as string[],
      status: t.status as MissionTask["status"],
      workerKind: t.workerKind,
      taskId: t.taskId,
    };
  }

  async updateMissionTaskStatus(
    missionId: string,
    taskId: string,
    status: MissionTask["status"],
  ): Promise<void> {
    await this.db
      .update(missionTasks)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(missionTasks.missionId, missionId), eq(missionTasks.id, taskId)));
  }

  async updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void> {
    await this.db
      .update(missions)
      .set({ status, updatedAt: new Date() })
      .where(eq(missions.id, missionId));
  }

  async deleteMission(missionId: string): Promise<void> {
    // Delete tasks first due to foreign key constraints
    await this.db.delete(missionTasks).where(eq(missionTasks.missionId, missionId));
    // Then delete the mission
    await this.db.delete(missions).where(eq(missions.id, missionId));
  }

  async list(filter?: { status?: Mission["status"] }): Promise<Mission[]> {
    const conditions = [];
    if (filter?.status) {
      conditions.push(eq(missions.status, filter.status));
    }
    const query = this.db.select().from(missions);
    const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query);
    return rows.map((m) => ({
      id: m.id,
      title: m.title,
      objective: m.objective,
      status: m.status as Mission["status"],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  async updateMissionTaskDependsOn(taskId: string, dependsOn: string[]): Promise<void> {
    await this.db
      .update(missionTasks)
      .set({ dependsOn: dependsOn })
      .where(eq(missionTasks.id, taskId));
  }

  async updateMission(missionId: string, mission: Mission): Promise<void> {
    await this.db
      .update(missions)
      .set({
        title: mission.title,
        objective: mission.objective,
        status: mission.status,
        updatedAt: new Date(),
      })
      .where(eq(missions.id, missionId));
  }
}
