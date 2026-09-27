import { randomUUID } from "node:crypto";
import type { AutonomousPlan } from "@/core/contracts/autonomous-plan";

import type { Mission, MissionTask, CreateMissionInput } from "@/core/mission/contracts";
import type { MissionRepository } from "@/server/mission/ports";
import type {
  MissionPlan,
} from "@/server/mission/mission-plan";
import {
  fingerprintMissionPlan,
  resolvePlanTaskMetadata,
  validateMissionPlan,
} from "@/server/mission/mission-plan";
import type { TaskRepository } from "@/server/repositories/ports";
import type { Task } from "@/core/contracts";

/**
 * In-memory implementation of the MissionRepository.
 * Used for testing and non-persistent environments.
 */
export class InMemoryMissionRepository implements MissionRepository {
  private missions: Map<string, Mission> = new Map();
  private missionTasks: Map<string, MissionTask> = new Map();
  private autonomousPlans: Map<string, AutonomousPlan[]> = new Map();

  constructor(private readonly taskRepository?: TaskRepository) {}

  async create(input: CreateMissionInput & { id?: string }): Promise<Mission> {
    if (input.id !== undefined) {
      if (input.tasks.length > 0) throw new Error("MISSION_CREATE_ID_REQUIRES_EMPTY_GRAPH");
      const existing = this.missions.get(input.id);
      if (existing) {
        if (existing.title !== input.title || existing.objective !== input.objective) {
          throw new Error("MISSION_ID_CONFLICT");
        }
        return existing;
      }
    }
    const missionId = input.id ?? randomUUID();
    const now = new Date();
    const mission: Mission = {
      id: missionId,
      title: input.title,
      objective: input.objective,
      goalId: input.goalId ?? undefined,
      planId: undefined,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    // Create canonical Tasks first (like PostgreSQL implementation)
    const createdTasks: Task[] = [];
    if (this.taskRepository) {
      for (const taskInput of input.tasks) {
        const created = await this.taskRepository.create({
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
        if (!created.ok) {
          throw new Error(
            `Failed to create canonical task: ${created.reason} - ${created.message}`,
          );
        }
        createdTasks.push(created.task);
      }
    } else {
      // Fallback for backward compatibility (should not happen in production)
      throw new Error(
        "TaskRepository required for MissionRepository.create() - cannot create MissionTasks without canonical Tasks",
      );
    }

    const missionTasks: MissionTask[] = input.tasks.map((task, index) => {
      const missionTaskId = randomUUID();
      const canonicalTask = createdTasks[index];
      const missionTask: MissionTask = {
        id: missionTaskId,
        missionId: missionId,
        title: task.title,
        description: task.description ?? null,
        dependsOn: task.dependsOn,
        status: "draft",
        workerKind: task.workerKind ?? null,
        capability: task.capability ?? null,
        taskId: canonicalTask.id, // Reference to the canonical task
      };
      this.missionTasks.set(missionTaskId, missionTask);
      return missionTask;
    });
    this.missions.set(missionId, mission);
    const createdMission: Mission = {
      ...mission,
      updatedAt: now,
    };
    return createdMission;
  }

  async applyPlan(
    missionId: string,
    plan: MissionPlan,
  ): Promise<MissionTask[]> {
    validateMissionPlan(plan);

    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(
        `MISSION_NOT_FOUND:${missionId}`,
      );
    }
    /*
     * Generic missions carry no autonomous plan lineage (mission N11).
     * See PostgresMissionRepository.applyPlan for the full rationale.
     */
    const goalId = mission.goalId ?? undefined;

    /*
     * N2.7 initial-plan invariant, matching PostgresMissionRepository:
     * applyPlan() may only initialize a mission that has no tasks yet.
     * Replanning has explicit semantics via replacePlan().
     */
    for (const missionTask of this.missionTasks.values()) {
      if (missionTask.missionId === missionId) {
        throw new Error(
          `MISSION_PLAN_ALREADY_APPLIED:${missionId}`,
        );
      }
    }

    /*
     * applyPlan idempotency (mission N8).
     *
     * planFingerprint is plan CONTENT; planId is plan IDENTITY.
     * They are never equal and the fingerprint is never used as an id.
     *
     * Reached when a previous attempt persisted the plan row but crashed
     * before materializing tasks: the same logical plan must reuse the same
     * durable planId rather than allocating a duplicate version.
     */
    let planId: string | undefined;

    if (goalId) {
      const planFingerprint =
        fingerprintMissionPlan(plan);

      const existingPlans =
        this.autonomousPlans.get(missionId) ??
        [];

      const samePlan = existingPlans.find(
        (p) =>
          p.planFingerprint ===
          planFingerprint,
      );

      if (samePlan) {
        planId = samePlan.planId;
      } else {
        planId = randomUUID();
        const newPlan: AutonomousPlan = {
          id: randomUUID(),
          missionId,
          goalId,
          planId,
          planFingerprint,
          version: 1,
          predecessorPlanId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        existingPlans.push(newPlan);
        this.autonomousPlans.set(
          missionId,
          existingPlans,
        );
      }

      // The mission pointer tracks the applied plan version.
      this.missions.set(missionId, {
        ...mission,
        planId,
        updatedAt: new Date(),
      });
    }

    if (!this.taskRepository) {
      throw new Error(
        "TaskRepository required for " +
          "MissionRepository.applyPlan()",
      );
    }

    /*
     * Allocate every MissionTask ID before creating anything so
     * planner keys can be resolved deterministically.
     */
    const missionTaskIdByKey = new Map<string, string>();

    for (const task of plan.tasks) {
      missionTaskIdByKey.set(
        task.key,
        randomUUID(),
      );
    }

    const createdTasks: Task[] = [];

    for (const task of plan.tasks) {
      const created = await this.taskRepository.create({
        missionId: missionId,
        goalId: goalId,
        planId: planId,
        title: task.title,
        description: task.description ?? undefined,
        // Planner-supplied metadata; fallbacks owned by resolvePlanTaskMetadata.
        ...resolvePlanTaskMetadata(task),
        dependencies: [],
        assignedAgentId: undefined,
      });
      if (!created.ok) {
        throw new Error(
          `Failed to create canonical task: ` +
            `${created.reason} - ` +
            `${created.message}`,
        );
      }
      createdTasks.push(created.task);
    }

    const result: MissionTask[] =
      plan.tasks.map((task, index) => {
        const id = missionTaskIdByKey.get(task.key);
        if (!id) {
          throw new Error(
            `MISSION_PLAN_INTERNAL_ID_MISSING:` +
              `${task.key}`,
          );
        }
        const dependsOn = task.dependsOn.map((dependencyKey) => {
          const dependencyId = missionTaskIdByKey.get(dependencyKey);
          if (!dependencyId) {
            throw new Error(
              `MISSION_PLAN_INTERNAL_DEPENDENCY_ID_MISSING:` +
                `${task.key}:${dependencyKey}`,
            );
          }
          return dependencyId;
        });
        const missionTask: MissionTask = {
          id,
          missionId,
          title: task.title,
          description: task.description ?? null,
          dependsOn,
          status: "draft",
          workerKind: task.workerKind ?? null,
          capability: task.capability ?? null,
          taskId: createdTasks[index].id,
        };
        this.missionTasks.set(id, missionTask);
        return missionTask;
      });

    return result;
  }

  /**
   * Immutable plan lineage, oldest version first.
   * Superseded versions are never removed or mutated.
   */
  async listPlanLineage(
    missionId: string,
  ): Promise<AutonomousPlan[]> {
    return [
      ...(this.autonomousPlans.get(missionId) ??
        []),
    ].sort((a, b) => a.version - b.version);
  }

  async replacePlan(missionId: string, plan: MissionPlan): Promise<MissionTask[]> {
    validateMissionPlan(plan);
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`MISSION_NOT_FOUND:${missionId}`);
    // Generic missions carry no autonomous plan lineage (mission N11).
    const goalId = mission.goalId ?? undefined;

    /*
     * Replanning lineage (mission N8), matching PostgresMissionRepository.
     *
     * A genuine replan APPENDS an immutable new version with a NEW planId:
     *
     *   P1 <- P2 <- P3
     *
     * Previous versions are never mutated, and predecessorPlanId carries the
     * superseded version's planId (its logical identity), never its
     * surrogate id.
     */
    let planId: string | undefined;

    if (goalId) {
      const planFingerprint =
        fingerprintMissionPlan(plan);

      const existingPlans =
        this.autonomousPlans.get(missionId) ??
        [];

      const currentPlan = existingPlans.reduce<
        AutonomousPlan | undefined
      >(
        (latest, candidate) =>
          !latest ||
          candidate.version > latest.version
            ? candidate
            : latest,
        undefined,
      );

      planId = randomUUID();

      existingPlans.push({
        id: randomUUID(),
        missionId,
        goalId,
        planId,
        planFingerprint,
        version: currentPlan
          ? currentPlan.version + 1
          : 1,
        predecessorPlanId:
          currentPlan?.planId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      this.autonomousPlans.set(
        missionId,
        existingPlans,
      );
    }

    if (!this.taskRepository) throw new Error("TaskRepository required for replacePlan()");

    const existing = await this.listTasks(missionId);
    if (existing.some((task) => ["queued", "running", "review_pending"].includes(task.status))) {
      throw new Error("MISSION_REPLAN_ACTIVE_WORK");
    }
    const succeeded = existing.filter((task) => task.status === "succeeded");
    const ids = new Map(plan.tasks.map((task) => [task.key, randomUUID()]));
    const created: MissionTask[] = [];
    for (const task of plan.tasks) {
      const canonical = await this.taskRepository.create({
        missionId: missionId,
        goalId: goalId,
        planId: planId,
        title: task.title,
        description: task.description,
        // Planner-supplied metadata; fallbacks owned by resolvePlanTaskMetadata.
        ...resolvePlanTaskMetadata(task),
        dependencies: [],
        assignedAgentId: undefined,
      });
      if (!canonical.ok) throw new Error("MISSION_REPLAN_TASK_CREATION_FAILED");
      created.push({
        id: ids.get(task.key)!,
        missionId,
        taskId: canonical.task.id,
        title: task.title,
        description: task.description ?? null,
        dependsOn: task.dependsOn.map((dependency) => ids.get(dependency)!),
        status: "draft",
        workerKind: task.workerKind ?? null,
        capability: task.capability ?? null,
      });
    }
    const superseded = existing
      .filter((task) => task.status !== "succeeded")
      .map((task) => ({ ...task, status: "superseded" as const }));
    for (const task of [...succeeded, ...superseded, ...created]) {
      this.missionTasks.set(task.id, task);
    }
    /*
     * The mission current-plan pointer advances to the new version, and never
     * moves backwards. A generic mission has no plan lineage, so its existing
     * pointer is preserved rather than cleared.
     */
    this.missions.set(missionId, {
      ...mission,
      planId: planId ?? mission.planId,
      updatedAt: new Date(),
    });
    return [...succeeded, ...superseded, ...created];
  }

  async findById(id: string): Promise<Mission | null> {
    return this.missions.get(id) ?? null;
  }

  async listTasks(missionId: string): Promise<MissionTask[]> {
    const tasks: MissionTask[] = [];
    for (const [taskId, task] of this.missionTasks) {
      if (task.missionId === missionId) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  async getMissionIdByTaskId(taskId: string): Promise<string | null> {
    for (const task of this.missionTasks.values()) {
      if (task.taskId === taskId) {
        return task.missionId;
      }
    }
    return null;
  }

  async getMissionTaskById(taskId: string): Promise<MissionTask | null> {
    return this.missionTasks.get(taskId) ?? null;
  }

  async getMissionTaskByCanonicalTaskId(canonicalTaskId: string): Promise<MissionTask | null> {
    for (const [, task] of this.missionTasks) {
      if (task.taskId === canonicalTaskId) {
        return task;
      }
    }
    return null;
  }

  async updateMissionTaskDependsOn(taskId: string, dependsOn: string[]): Promise<void> {
    const task = this.missionTasks.get(taskId);
    if (!task) {
      throw new Error(`Mission task not found: ${taskId}`);
    }
    // Create a new task object with updated dependsOn
    const updatedTask: MissionTask = {
      ...task,
      dependsOn,
    };
    this.missionTasks.set(taskId, updatedTask);
  }

  async updateMissionTaskStatus(
    missionId: string,
    taskId: string,
    status: MissionTask["status"],
  ): Promise<void> {
    const task = this.missionTasks.get(taskId);
    if (!task) {
      throw new Error(`Mission task not found: ${taskId}`);
    }
    // Create a new task object with updated status
    const updatedTask: MissionTask = {
      ...task,
      status,
    };
    this.missionTasks.set(taskId, updatedTask);
  }

  async updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void> {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    // Create a new mission object with updated status
    const updatedMission: Mission = {
      ...mission,
      status,
      updatedAt: new Date(),
    };
    this.missions.set(missionId, updatedMission);
  }

  async deleteMission(missionId: string): Promise<void> {
    // Delete all tasks associated with the mission
    for (const [taskId, task] of this.missionTasks) {
      if (task.missionId === missionId) {
        this.missionTasks.delete(taskId);
      }
    }
    // Delete the mission
    this.missions.delete(missionId);
    // Also delete any autonomous plan for this mission
    this.autonomousPlans.delete(missionId);
  }

  async list(filter?: { status?: Mission["status"] }): Promise<Mission[]> {
    let missions = Array.from(this.missions.values());
    if (filter?.status) {
      missions = missions.filter((m) => m.status === filter.status);
    }
    return missions;
  }

  async updateMission(missionId: string, mission: Mission): Promise<void> {
    const existing = this.missions.get(missionId);
    if (!existing) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    this.missions.set(missionId, mission);
  }
}