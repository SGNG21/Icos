import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import type { Mission, MissionTask } from "@/core/mission/contracts";
import { missions, missionTasks, tasks } from "@/server/database/schema";
import type { Database } from "@/server/database/client";
import type { MissionRepository } from "@/server/mission/ports";
import type {
  MissionPlan,
} from "@/server/mission/mission-plan";
import {
  validateMissionPlan,
} from "@/server/mission/mission-plan";
import type { TaskRepository } from "@/server/repositories/ports";
import { auditToRow, rowToMissionTask, taskToRow } from "@/server/database/mappers";
import { prepareTaskCreation } from "@/server/repositories/task-creation";
import { auditEntries } from "@/server/database/schema";

/**
 * Repository PostgreSQL des missions.
 */
export class PostgresMissionRepository implements MissionRepository {
  constructor(
    private readonly db: Database,
    private readonly taskRepository: TaskRepository,
  ) {}

  private async hydrateMissionTaskRows(
    rows: (typeof missionTasks.$inferSelect)[],
  ): Promise<MissionTask[]> {
    if (rows.length === 0) {
      return [];
    }

    // We need to fetch the canonical tasks for each mission task to build the MissionTask object correctly.
    // However, note that the MissionTask schema expects a taskId (canonical task id) and we have that in the missionTasks table.
    // We also need to fetch the task details from the tasks table to get the title, description, etc.?
    // Actually, the MissionTask object in the domain includes:
    //   id: mission task id (from missionTasks)
    //   missionId: from missionTasks
    //   title: from missionTasks (we store it there)
    //   description: from missionTasks (we store it there)
    //   dependsOn: from missionTasks (we store it there as jsonb)
    //   status: from missionTasks
    //   workerKind: from missionTasks
    //   capability: from missionTasks
    //   taskId: the canonical task id (foreign key to tasks table)
    // So we have all we need in the missionTasks table, except we might want to validate that the canonical task exists?
    // We'll just map directly.

    return rows.map(rowToMissionTask);
  }

  async create(input: {
    id?: string;
    title: string;
    objective: string;
    goalId?: string;
    tasks: Omit<
      MissionTask,
      "id" | "missionId" | "status" | "taskId"
    >[];
  }): Promise<Mission> {
    if (input.id !== undefined) {
      return this.createWithImposedId(
        input.id,
        input.title,
        input.objective,
        input.tasks.length,
      );
    }

    const missionId = randomUUID();
    const now = new Date();

    const mission: Mission = {
      id: missionId,
      title: input.title,
      objective: input.objective,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    // Build and validate every canonical Task + audit before opening
    // the database transaction. No persistence occurs here.
    const preparedTasks = input.tasks.map((taskInput) => {
      const prepared = prepareTaskCreation({
        missionId: missionId,
        goalId: input.goalId ?? undefined,
        planId: undefined,
        title: taskInput.title,
        description: taskInput.description ?? undefined,
        objective: input.objective,
        instructions: taskInput.description ?? '',
        dependencies: [],
        successCriteria: [],
        requiredCapabilities: [],
        riskClass: 'reversible',
        allowedFileScope: [],
        expectedArtifacts: [],
        priority: 3,
        attemptBudget: 3,
        reviewPolicy: 'if_risky',
        integrationPolicy: '',
        assignedAgentId: undefined,
      });

      if (!prepared.ok) {
        throw new Error(
          `Failed to create canonical task: ` +
            `${prepared.reason} - ${prepared.message}`,
        );
      }

      return prepared;
    });

    const missionTasksToInsert = input.tasks.map(
      (taskInput, index) => ({
        id: randomUUID(),
        missionId,
        title: taskInput.title,
        description: taskInput.description ?? null,
        dependsOn: taskInput.dependsOn,
        status: "draft",
        workerKind: taskInput.workerKind ?? null,
        capability: taskInput.capability ?? null,
        taskId: preparedTasks[index].task.id,
        createdAt: now,
        updatedAt: now,
      }),
    );

    // N2.7-0.c:
    // canonical Tasks + task.created audits + Mission + MissionTasks
    // form one atomic persistence unit.
    await this.db.transaction(async (tx) => {
      for (const prepared of preparedTasks) {
        await tx
          .insert(tasks)
          .values(taskToRow(prepared.task));

        await tx
          .insert(auditEntries)
          .values(auditToRow(prepared.auditEntry));
      }

      await tx.insert(missions).values({
        id: missionId,
        title: input.title,
        objective: input.objective,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });

      if (missionTasksToInsert.length > 0) {
        await tx
          .insert(missionTasks)
          .values(missionTasksToInsert);
      }
    });

    return mission;
  }

  /**
   * Idempotent creation (empty graph only): the primary key arbitrates
   * concurrent creators; a replay returns the stored mission.
   */
  private async createWithImposedId(
    id: string,
    title: string,
    objective: string,
    taskCount: number,
  ): Promise<Mission> {
    if (taskCount > 0) throw new Error("MISSION_CREATE_ID_REQUIRES_EMPTY_GRAPH");
    const now = new Date();
    await this.db
      .insert(missions)
      .values({ id, title, objective, status: "draft", createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: missions.id });
    const stored = await this.findById(id);
    if (!stored) throw new Error("MISSION_CREATE_INVARIANT_VIOLATED");
    if (stored.title !== title || stored.objective !== objective) {
      throw new Error("MISSION_ID_CONFLICT");
    }
    return stored;
  }

  async applyPlan(
    missionId: string,
    plan: MissionPlan,
  ): Promise<MissionTask[]> {
    validateMissionPlan(plan);

    /*
     * Planner keys are intentionally resolved BEFORE persistence.
     *
     * MissionTask.dependsOn always contains MissionTask.id values
     * once the plan reaches the repository/domain boundary.
     */
    const now = new Date();

    const missionTaskIdByKey =
      new Map<string, string>();

    for (const task of plan.tasks) {
      missionTaskIdByKey.set(
        task.key,
        randomUUID(),
      );
    }

    /*
     * Build + validate every canonical Task and task.created audit
     * before opening the transaction.
     *
     * prepareTaskCreation() has no persistence side effect.
     */
    const preparedTasks =
      plan.tasks.map((task) => {
        const prepared =
          prepareTaskCreation({
            missionId: missionId,
            goalId: input.goalId,
            planId: undefined, // TODO: derive from plan if available
            title: task.title,
            description: task.description ?? undefined,
            objective: task.title, // or maybe we should get from goal? but for now use title
            instructions: task.description ?? '',
            dependencies: [],
            successCriteria: [],
            requiredCapabilities: [],
            riskClass: 'reversible',
            allowedFileScope: [],
            expectedArtifacts: [],
            priority: 3,
            attemptBudget: 3,
            reviewPolicy: 'if_risky',
            integrationPolicy: '',
            assignedAgentId: undefined,
          });

        if (!prepared.ok) {
          throw new Error(
            `Failed to prepare canonical task: ` +
              `${prepared.reason} - ` +
              `${prepared.message}`,
          );
        }

        return prepared;
      });

    const missionTasksToInsert =
      plan.tasks.map((task, index) => {
        const id =
          missionTaskIdByKey.get(task.key);

        if (!id) {
          throw new Error(
            `MISSION_PLAN_INTERNAL_ID_MISSING:` +
              `${task.key}`,
          );
        }

        const resolvedDependsOn =
          task.dependsOn.map((dependencyKey) => {
            const dependencyId =
              missionTaskIdByKey.get(
                dependencyKey,
              );

            if (!dependencyId) {
              throw new Error(
                `MISSION_PLAN_INTERNAL_DEPENDENCY_ID_MISSING:` +
                  `${task.key}:${dependencyKey}`,
              );
            }

            return dependencyId;
          });

        return {
          id,
          missionId,
          title: task.title,
          description:
            task.description ?? null,
          dependsOn: resolvedDependsOn,
          status: "draft" as const,
          workerKind:
            task.workerKind ?? null,
          capability:
            task.capability ?? null,
          taskId:
            preparedTasks[index].task.id,
          createdAt: now,
          updatedAt: now,
        };
      });

    await this.db.transaction(async (tx) => {
      /*
       * Fail closed:
       * the mission must exist when the plan is applied.
       */
      const missionRows = await tx
        .select({
          id: missions.id,
        })
        .from(missions)
        .where(eq(missions.id, missionId))
        .limit(1);

      if (!missionRows[0]) {
        throw new Error(
          `MISSION_NOT_FOUND:${missionId}`,
        );
      }

      /*
       * N2.7 initial-plan invariant:
       * applyPlan() may only initialize an empty mission.
       *
       * Replanning will get its own explicit semantics instead
       * of silently appending duplicate DAG nodes.
       */
      const existingTasks = await tx
        .select({
          id: missionTasks.id,
        })
        .from(missionTasks)
        .where(
          eq(
            missionTasks.missionId,
            missionId,
          ),
        )
        .limit(1);

      if (existingTasks[0]) {
        throw new Error(
          `MISSION_PLAN_ALREADY_APPLIED:${missionId}`,
        );
      }

      for (const prepared of preparedTasks) {
        await tx
          .insert(tasks)
          .values(
            taskToRow(prepared.task),
          );

        await tx
          .insert(auditEntries)
          .values(
            auditToRow(
              prepared.auditEntry,
            ),
          );
      }

      await tx
        .insert(missionTasks)
        .values(missionTasksToInsert);

      await tx
        .update(missions)
        .set({
          updatedAt: now,
        })
        .where(
          eq(missions.id, missionId),
        );
    });

    return missionTasksToInsert.map(
      rowToMissionTask,
    );
  }

  async replacePlan(missionId: string, plan: MissionPlan): Promise<MissionTask[]> {
    validateMissionPlan(plan);
    const now = new Date();
    const missionTaskIdByKey = new Map(plan.tasks.map((task) => [task.key, randomUUID()]));
    const preparedTasks = plan.tasks.map((task) => {
      const prepared = prepareTaskCreation({
        missionId: missionId,
        goalId: missionId, // TODO: derive from goal if available
        planId: missionId, // TODO: derive from plan if available
        title: task.title,
        description: task.description,
        objective: task.title, // or maybe we should get from goal? but for now use title
        instructions: task.description ?? '',
        dependencies: [],
        successCriteria: [],
        requiredCapabilities: [],
        riskClass: 'reversible',
        allowedFileScope: [],
        expectedArtifacts: [],
        priority: 3,
        attemptBudget: 3,
        reviewPolicy: 'if_risky',
        integrationPolicy: '',
        assignedAgentId: undefined,
      });
      if (!prepared.ok) throw new Error("MISSION_REPLAN_TASK_PREPARATION_FAILED");
      return prepared;
    });
    const replacements = plan.tasks.map((task, index) => ({
      id: missionTaskIdByKey.get(task.key)!,
      missionId,
      title: task.title,
      description: task.description ?? null,
      dependsOn: task.dependsOn.map((dependency) => missionTaskIdByKey.get(dependency)!),
      status: "draft" as const,
      workerKind: task.workerKind ?? null,
      capability: task.capability ?? null,
      taskId: preparedTasks[index].task.id,
      createdAt: now,
      updatedAt: now,
    }));

    return this.db.transaction(async (tx) => {
      const missionRows = await tx
        .select({ id: missions.id })
        .from(missions)
        .where(eq(missions.id, missionId))
        .limit(1)
        .for("update");
      if (!missionRows[0]) throw new Error(`MISSION_NOT_FOUND:${missionId}`);

      const existing = await tx
        .select()
        .from(missionTasks)
        .where(eq(missionTasks.missionId, missionId))
        .orderBy(asc(missionTasks.createdAt), asc(missionTasks.id))
        .for("update");
      if (existing.some((task) => ["queued", "running", "review_pending"].includes(task.status))) {
        throw new Error("MISSION_REPLAN_ACTIVE_WORK");
      }
      const superseded = existing.filter((task) => task.status !== "succeeded");
      const toSupersede = existing.filter((task) => {
        const status = task.status;
        return (
          status === "draft" ||
          status === "queued" ||
          status === "awaiting_approval" ||
          status === "running" ||
          status === "review_pending"
        );
      });
      if (toSupersede.length > 0) {
        await tx
          .update(missionTasks)
          .set({ status: "superseded", updatedAt: now })
          .where(inArray(missionTasks.id, toSupersede.map((task) => task.id)));
      }
      for (const prepared of preparedTasks) {
        await tx.insert(tasks).values(taskToRow(prepared.task));
        await tx.insert(auditEntries).values(auditToRow(prepared.auditEntry));
      }
      await tx.insert(missionTasks).values(replacements);
      await tx.update(missions).set({ updatedAt: now }).where(eq(missions.id, missionId));

      return [
        ...existing.filter((task) => task.status === "succeeded").map(rowToMissionTask),
        ...replacements.map(rowToMissionTask),
      ];
    });
  }

  async findById(id: string): Promise<Mission | null> {
    const result = await this.db.select().from(missions).where(eq(missions.id, id)).limit(1);

    if (!result[0]) {
      return null;
    }

    return {
      id: result[0].id,
      title: result[0].title,
      objective: result[0].objective,
      status: result[0].status as Mission["status"],
      createdAt: new Date(result[0].createdAt),
      updatedAt: new Date(result[0].updatedAt),
    };
  }

  async listTasks(missionId: string): Promise<MissionTask[]> {
    const result = await this.db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.missionId, missionId))
      .orderBy(asc(missionTasks.createdAt), asc(missionTasks.id));

    return this.hydrateMissionTaskRows(result);
  }

  async getMissionIdByTaskId(taskId: string): Promise<string | null> {
    const result = await this.db
      .select({ missionId: missionTasks.missionId })
      .from(missionTasks)
      .where(eq(missionTasks.taskId, taskId))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return result[0].missionId;
  }

  async getMissionTaskById(taskId: string): Promise<MissionTask | null> {
    const result = await this.db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.id, taskId))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return rowToMissionTask(result[0]);
  }

  async getMissionTaskByCanonicalTaskId(canonicalTaskId: string): Promise<MissionTask | null> {
    const result = await this.db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.taskId, canonicalTaskId))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return rowToMissionTask(result[0]);
  }

  async updateMissionTaskDependsOn(taskId: string, dependsOn: string[]): Promise<void> {
    await this.db.update(missionTasks).set({ dependsOn }).where(eq(missionTasks.id, taskId));
  }

  async updateMissionTaskStatus(
    missionId: string,
    taskId: string,
    status: MissionTask["status"],
  ): Promise<void> {
    await this.db
      .update(missionTasks)
      .set({ status })
      .where(and(eq(missionTasks.id, taskId), eq(missionTasks.missionId, missionId)));
  }

  async updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void> {
    await this.db.update(missions).set({ status }).where(eq(missions.id, missionId));
  }

  async deleteMission(missionId: string): Promise<void> {
    // Delete all mission tasks associated with the mission
    await this.db.delete(missionTasks).where(eq(missionTasks.missionId, missionId));
    // Delete the mission
    await this.db.delete(missions).where(eq(missions.id, missionId));
  }

  async list(filter?: { status?: Mission["status"] }): Promise<Mission[]> {
    let result = await this.db
      .select()
      .from(missions)
      .orderBy(asc(missions.createdAt), asc(missions.id));

    if (filter?.status) {
      result = result.filter((r) => r.status === filter.status);
    }

    return result.map((r) => ({
      id: r.id,
      title: r.title,
      objective: r.objective,
      status: r.status as Mission["status"],
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
    }));
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
