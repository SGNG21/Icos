import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { Task } from "@/core/contracts";
import type { AutonomousPlan } from "@/core/contracts/autonomous-plan";
import type { MissionPlan } from "@/server/mission/mission-plan";

export interface MissionRepository {
  create(input: {
    /**
     * Impose l'id de la Mission (création IDEMPOTENTE, graphe vide uniquement) : un
     * rejeu avec le même id et le même contenu renvoie la Mission existante ; un même
     * id pour un autre contenu lève MISSION_ID_CONFLICT.
     */
    id?: string;
    title: string;
    objective: string;
    goalId?: string;
    /**
     * Mission tasks, each optionally carrying CANONICAL PLANNING METADATA (defect 24).
     *
     * `create()` used to INVENT this metadata — `riskClass: 'reversible'`,
     * `allowedFileScope: []`, priority 3, attemptBudget 3, reviewPolicy 'if_risky' — as
     * hardcoded literals. Under governance that made every inline-created writer task
     * unrunnable: it claimed to be a writer while declaring no scope, which the allocation
     * policy must refuse (decision 0042).
     *
     * There is ONE task-creation authority, `prepareTaskCreation`, and ONE source of
     * defaults, `taskSchema`. What the caller declares is passed through; what it omits is
     * left to the schema. Nothing is invented here, so no second planning contract exists.
     *
     * `applyPlan` remains the authority for PLANNED tasks; this is the manual path, and it
     * can now express the same metadata rather than silently faking it.
     */
    tasks: (Omit<MissionTask, "id" | "missionId" | "status" | "taskId"> &
      Partial<
        Pick<
          Task,
          | "objective"
          | "instructions"
          | "successCriteria"
          | "requiredCapabilities"
          | "riskClass"
          | "allowedFileScope"
          | "expectedArtifacts"
          | "priority"
          | "attemptBudget"
          | "reviewPolicy"
          | "integrationPolicy"
        >
      >)[];
  }): Promise<Mission>;
  /**
   * Atomically applies a validated planner DAG to an existing mission.
   *
   * MissionPlan dependencies reference planner-local keys.
   * Persistence resolves them to MissionTask.id values.
   */
  applyPlan(
    missionId: string,
    plan: MissionPlan,
  ): Promise<MissionTask[]>;
  /** Atomically replaces unfinished graph work while preserving succeeded history. */
  replacePlan?(missionId: string, plan: MissionPlan): Promise<MissionTask[]>;

  /**
   * Immutable plan lineage for a mission, oldest version first.
   *
   * Superseded versions remain queryable: the chain P1 <- P2 <- P3 is
   * history, not mutable state. Used to prove replanning lineage.
   */
  listPlanLineage?(
    missionId: string,
  ): Promise<AutonomousPlan[]>;

  findById(id: string): Promise<Mission | null>;
  list(filter?: { status?: Mission["status"] }): Promise<Mission[]>;
  listTasks(missionId: string): Promise<MissionTask[]>;
  getMissionIdByTaskId(taskId: string): Promise<string | null>;
  getMissionTaskById(taskId: string): Promise<MissionTask | null>;
  getMissionTaskByCanonicalTaskId(taskId: string): Promise<MissionTask | null>;
  updateMissionTaskStatus(
    missionId: string,
    taskId: string,
    status: MissionTask["status"],
  ): Promise<void>;
  /**
   * Unconditional status write. `cancelled` is terminal (machine) and sticky:
   * implementations never move a mission OUT of `cancelled` (decision 0055).
   */
  updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void>;
  /**
   * Compare-and-set (decision 0055): writes `to` only if the status is still
   * `from`; false if it changed underneath. Optional like replacePlan: callers
   * that need it (the control command bus) fail closed without it.
   */
  transitionMissionStatusIf?(
    missionId: string,
    from: Mission["status"],
    to: Mission["status"],
  ): Promise<boolean>;
  deleteMission(missionId: string): Promise<void>;
  updateMission(missionId: string, mission: Mission): Promise<void>;
  updateMissionTaskDependsOn(taskId: string, dependsOn: string[]): Promise<void>;
}
