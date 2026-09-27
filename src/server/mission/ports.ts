import type { Mission, MissionTask } from "@/core/mission/contracts";
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
    tasks: Omit<MissionTask, "id" | "missionId" | "status" | "taskId">[];
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
  updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void>;
  deleteMission(missionId: string): Promise<void>;
  updateMission(missionId: string, mission: Mission): Promise<void>;
  updateMissionTaskDependsOn(taskId: string, dependsOn: string[]): Promise<void>;
}
