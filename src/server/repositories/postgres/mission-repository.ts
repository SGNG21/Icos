import { randomUUID } from "node:crypto";
import type { AutonomousPlan } from "@/server/database/schema";
import { autonomousPlans } from "@/server/database/schema";

import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { MissionStatus } from "@/core/mission/contracts";

import type { Mission, MissionTask } from "@/core/mission/contracts";
import { missions, missionTasks, tasks } from "@/server/database/schema";
import type { Database } from "@/server/database/client";
import type { MissionRepository } from "@/server/mission/ports";
import type {
  MissionPlan,
} from "@/server/mission/mission-plan";
import {
  fingerprintMissionPlan,
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
      goalId: input.goalId ?? undefined,
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
        goalId: input.goalId ?? null,
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
    const missionObj = await this.findById(missionId);
    if (!missionObj) {
      throw new Error(`MISSION_NOT_FOUND:${missionId}`);
    }
    /*
     * Autonomous vs generic missions (mission N11).
     *
     * A goal-backed mission is autonomous: it receives immutable plan lineage
     * in autonomous_plans and its canonical Tasks carry goalId + planId.
     *
     * A mission with no goalId is a generic/manual mission. The canonical Task
     * contract declares goalId/planId OPTIONAL for exactly this case
     * (taskSchema, versus the strict autonomousTaskSpecSchema), so the strict
     * autonomous requirement must not be forced onto the generic path.
     *
     * Lineage is SKIPPED, never faked: goalId is never defaulted to missionId
     * and planId is never invented.
     */
    const goalId = missionObj.goalId ?? undefined;

    let planId: string | undefined;

    if (goalId) {
      /*
       * applyPlan idempotency (mission N8).
       *
       * Keyed on the plan FINGERPRINT, not merely on missionId: an applyPlan
       * retry of the same logical plan must reuse the same persisted plan
       * version (P1/version 1) instead of allocating a duplicate row.
       *
       * planFingerprint is content; planId is identity. Never equal.
       */
      const planFingerprint =
        fingerprintMissionPlan(plan);

      const existingPlan = await this.db
        .select()
        .from(autonomousPlans)
        .where(
          and(
            eq(
              autonomousPlans.missionId,
              missionId,
            ),
            eq(
              autonomousPlans.planFingerprint,
              planFingerprint,
            ),
          ),
        )
        .limit(1);

      if (existingPlan[0]) {
        // Same logical plan already persisted: reuse its durable identity.
        planId = existingPlan[0].planId;
      } else {
        // First version of this mission's plan chain.
        planId = randomUUID();
        await this.db
          .insert(autonomousPlans)
          .values({
            id: randomUUID(),
            missionId,
            goalId,
            planId,
            planFingerprint,
            version: 1,
            predecessorPlanId: null,
            createdAt: now,
            updatedAt: now,
          });
      }

      // Ensure the mission points to the current plan version.
      await this.db
        .update(missions)
        .set({ planId })
        .where(eq(missions.id, missionId));
    }

    const preparedTasks =
      plan.tasks.map((task) => {
        const prepared =
          prepareTaskCreation({
            missionId: missionId,
            goalId: goalId,
            planId: planId,
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

  /**
   * Immutable plan lineage, oldest version first.
   * Superseded versions are never removed or mutated.
   */
  async listPlanLineage(
    missionId: string,
  ): Promise<AutonomousPlan[]> {
    return await this.db
      .select()
      .from(autonomousPlans)
      .where(
        eq(
          autonomousPlans.missionId,
          missionId,
        ),
      )
      .orderBy(asc(autonomousPlans.version));
  }

  async replacePlan(missionId: string, plan: MissionPlan): Promise<MissionTask[]> {
    validateMissionPlan(plan);
    const now = new Date();
    const missionTaskIdByKey = new Map(plan.tasks.map((task) => [task.key, randomUUID()]));
    const missionObj = await this.findById(missionId);
    if (!missionObj) {
      throw new Error(`MISSION_NOT_FOUND:${missionId}`);
    }
    // See applyPlan: generic missions carry no autonomous plan lineage.
    const goalId = missionObj.goalId ?? undefined;

    /*
     * Replanning lineage (mission N8).
     *
     * A genuine replan APPENDS an immutable new version:
     *
     *   P1 <- P2 <- P3
     *
     * The superseded row is never mutated: previous AutonomousPlan versions
     * are immutable history. predecessorPlanId carries the previous version's
     * planId (its logical identity), never its surrogate id.
     */
    let planId: string | undefined;

    if (goalId) {
      const planFingerprint =
        fingerprintMissionPlan(plan);

      const currentPlan = await this.db
        .select()
        .from(autonomousPlans)
        .where(
          eq(
            autonomousPlans.missionId,
            missionId,
          ),
        )
        .orderBy(
          desc(autonomousPlans.version),
        )
        .limit(1);

      planId = randomUUID();

      await this.db
        .insert(autonomousPlans)
        .values({
          id: randomUUID(),
          missionId,
          goalId,
          planId,
          planFingerprint,
          /*
           * No current row means replacePlan was reached without a persisted
           * plan version. The in-transaction MISSION_PLAN_NOT_APPLIED check
           * below is the authoritative guard; rooting the chain at version 1
           * only keeps the lineage well-formed.
           */
          version: currentPlan[0]
            ? currentPlan[0].version + 1
            : 1,
          predecessorPlanId:
            currentPlan[0]?.planId ?? null,
          createdAt: now,
          updatedAt: now,
        });

      /*
       * The mission current-plan pointer advances to the new version.
       * It never moves backwards to a superseded plan.
       */
      await this.db
        .update(missions)
        .set({ planId })
        .where(eq(missions.id, missionId));
    }

    const preparedTasks =
      plan.tasks.map((task) => {
        const prepared =
          prepareTaskCreation({
            missionId: missionId,
            goalId: goalId,
            planId: planId,
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

    /*
     * Captured inside the transaction so the returned graph reflects exactly
     * what was persisted.
     */
    let preservedIds: string[] = [];
    let supersededIds: string[] = [];

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
       * N2.7 replanning invariant:
       * replacePlan() may only be called on a mission that already has a plan applied.
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

      if (!existingTasks[0]) {
        throw new Error(
          `MISSION_PLAN_NOT_APPLIED:${missionId}`,
        );
      }

      /*
       * Replanning preserves history; it is NOT a clean slate.
       *
       * Matches InMemoryMissionRepository.replacePlan:
       *   - active work blocks the replan entirely (fail closed)
       *   - succeeded MissionTasks are preserved untouched
       *   - every other pre-existing MissionTask becomes `superseded`
       *   - the new plan's tasks are inserted as `draft`
       *
       * Rows are never deleted: a MissionTask that ran is durable evidence,
       * and its canonical Task + audit entries must stay referentially valid.
       */
      const priorTasks = await tx
        .select()
        .from(missionTasks)
        .where(
          eq(
            missionTasks.missionId,
            missionId,
          ),
        );

      const ACTIVE_STATUSES = [
        "queued",
        "running",
        "review_pending",
      ];

      if (
        priorTasks.some((task) =>
          ACTIVE_STATUSES.includes(task.status),
        )
      ) {
        throw new Error(
          "MISSION_REPLAN_ACTIVE_WORK",
        );
      }

      supersededIds = priorTasks
        .filter(
          (task) => task.status !== "succeeded",
        )
        .map((task) => task.id);

      preservedIds = priorTasks
        .filter(
          (task) => task.status === "succeeded",
        )
        .map((task) => task.id);

      if (supersededIds.length > 0) {
        await tx
          .update(missionTasks)
          .set({
            status: "superseded",
            updatedAt: now,
          })
          .where(
            inArray(
              missionTasks.id,
              supersededIds,
            ),
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

    /*
     * The replaced graph is preserved succeeded work + superseded history +
     * the newly created tasks, read back from the durable rows.
     */
    const retainedIds = [
      ...preservedIds,
      ...supersededIds,
    ];

    const retained =
      retainedIds.length > 0
        ? await this.db
            .select()
            .from(missionTasks)
            .where(
              inArray(
                missionTasks.id,
                retainedIds,
              ),
            )
        : [];

    return [
      ...retained.map(rowToMissionTask),
      ...missionTasksToInsert.map(
        rowToMissionTask,
      ),
    ];
  }

  async findById(id: string): Promise<Mission | null> {
    const mission = await this.db
      .select({
        id: missions.id,
        title: missions.title,
        objective: missions.objective,
        status: missions.status,
        createdAt: missions.createdAt,
        updatedAt: missions.updatedAt,
        goalId: missions.goalId,
        planId: missions.planId,
      })
      .from(missions)
      .where(eq(missions.id, id))
      .limit(1);

    if (!mission[0]) {
      return null;
    }

    return {
      id: mission[0].id,
      title: mission[0].title,
      objective: mission[0].objective,
      status: mission[0].status as MissionStatus,
      goalId: mission[0].goalId ?? undefined,
      planId: mission[0].planId ?? undefined,
      createdAt: mission[0].createdAt,
      updatedAt: mission[0].updatedAt,
    };
  }

  async list(filter?: { status?: Mission["status"] }): Promise<Mission[]> {
    let result = await this.db
      .select({
        id: missions.id,
        title: missions.title,
        objective: missions.objective,
        status: missions.status,
        goalId: missions.goalId,
        planId: missions.planId,
        createdAt: missions.createdAt,
        updatedAt: missions.updatedAt,
      })
      .from(missions)
      .orderBy(asc(missions.createdAt), asc(missions.id));

    if (filter?.status) {
      result = result.filter((r) => r.status === filter.status);
    }

    return result.map((r) => ({
      id: r.id,
      title: r.title,
      objective: r.objective,
      status: r.status as MissionStatus,
      goalId: r.goalId ?? undefined,
      planId: r.planId ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async listTasks(missionId: string): Promise<MissionTask[]> {
    const missionTaskRows = await this.db
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
        createdAt: missionTasks.createdAt,
        updatedAt: missionTasks.updatedAt,
      })
      .from(missionTasks)
      .where(eq(missionTasks.missionId, missionId));
    return missionTaskRows.map(rowToMissionTask);
  }

  async getMissionIdByTaskId(taskId: string): Promise<string | null> {
    const result = await this.db
      .select({ missionId: missionTasks.missionId })
      .from(missionTasks)
      .where(eq(missionTasks.id, taskId))
      .limit(1);
    return result[0]?.missionId ?? null;
  }

  async getMissionTaskById(taskId: string): Promise<MissionTask | null> {
    const result = await this.db
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
        createdAt: missionTasks.createdAt,
        updatedAt: missionTasks.updatedAt,
      })
      .from(missionTasks)
      .where(eq(missionTasks.id, taskId))
      .limit(1);
    return result[0] ? rowToMissionTask(result[0]) : null;
  }

  async getMissionTaskByCanonicalTaskId(canonicalTaskId: string): Promise<MissionTask | null> {
    const result = await this.db
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
        createdAt: missionTasks.createdAt,
        updatedAt: missionTasks.updatedAt,
      })
      .from(missionTasks)
      .where(eq(missionTasks.taskId, canonicalTaskId))
      .limit(1);
    return result[0] ? rowToMissionTask(result[0]) : null;
  }

  async updateMissionTaskStatus(
    missionId: string,
    taskId: string,
    status: MissionTask["status"]
  ): Promise<void> {
    await this.db
      .update(missionTasks)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(missionTasks.id, taskId),
          eq(missionTasks.missionId, missionId)
        )
      );
  }

  async updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void> {
    await this.db
      .update(missions)
      .set({ status, updatedAt: new Date() })
      .where(eq(missions.id, missionId));
  }

  async deleteMission(missionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(missionTasks).where(eq(missionTasks.missionId, missionId));
      await tx.delete(missions).where(eq(missions.id, missionId));
      await tx.delete(autonomousPlans).where(eq(autonomousPlans.missionId, missionId));
    });
  }

  async updateMission(missionId: string, mission: Mission): Promise<void> {
    await this.db
      .update(missions)
      .set({
        title: mission.title,
        objective: mission.objective,
        goalId: mission.goalId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(missions.id, missionId));
  }

  async updateMissionTaskDependsOn(taskId: string, dependsOn: string[]): Promise<void> {
    await this.db
      .update(missionTasks)
      .set({ dependsOn, updatedAt: new Date() })
      .where(eq(missionTasks.id, taskId));
  }
}