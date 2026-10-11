import type { Task } from "@/core/contracts";
import {
  executionScopeFromGoal,
  ExecutionScopeMismatchError,
  scopeOfMetadata,
  type ExecutionScope,
} from "@/core/execution/execution-scope";
import type { Mission } from "@/core/mission/contracts";
import type { GoalRepository } from "@/server/repositories/ports";

/**
 * READS the execution scope of a mission or a task from its goal — the one source (decision
 * 0063 amendment A). It stores nothing, caches nothing and decides nothing: a mission's scope
 * is its goal's metadata, reached through `missions.goal_id`; a task's is the same, and the
 * task's own `goal_id` must agree with its mission's.
 */
export class ExecutionScopeReader {
  constructor(
    private readonly deps: {
      goals: Pick<GoalRepository, "getById">;
      missions: { findById(id: string): Promise<Pick<Mission, "id" | "goalId"> | null> };
      tasks?: { getById(id: string): Promise<Pick<Task, "id" | "goalId" | "missionId"> | null> };
    },
  ) {}

  /** Null when the mission does not exist. A mission with no goal is unscoped (`tenant`). */
  async forMission(missionId: string): Promise<ExecutionScope | null> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission) return null;
    return this.fromGoal(mission.goalId ?? null, { missionId });
  }

  /**
   * FAIL CLOSED. The scope a task executes under. Throws `ExecutionScopeMismatchError` when
   * the task's lineage disagrees with its mission's — a task that names another mission,
   * another goal, or a goal declaring another client — because presenting that task to a
   * worker under either scope would be presenting it under a scope it may not belong to.
   */
  async forTask(missionId: string, taskId: string): Promise<ExecutionScope | null> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission) return null;
    const missionGoalId = mission.goalId ?? null;
    const task = this.deps.tasks ? await this.deps.tasks.getById(taskId) : null;
    if (task) {
      if (task.missionId !== undefined && task.missionId !== missionId) {
        throw new ExecutionScopeMismatchError("missionId");
      }
      const taskGoalId = task.goalId ?? null;
      if (taskGoalId !== null && missionGoalId !== null && taskGoalId !== missionGoalId) {
        // Two goals: they must at least declare the same scope, or the task is refused.
        const [a, b] = await Promise.all([
          this.deps.goals.getById(taskGoalId),
          this.deps.goals.getById(missionGoalId),
        ]);
        const sa = scopeOfMetadata(a?.goal.metadata);
        const sb = scopeOfMetadata(b?.goal.metadata);
        if (sa.clientId !== sb.clientId || sa.projectId !== sb.projectId) {
          throw new ExecutionScopeMismatchError("goalId");
        }
      }
      if (taskGoalId !== null && missionGoalId === null) {
        // The task claims a goal its mission does not have: its scope is unverifiable.
        throw new ExecutionScopeMismatchError("goalId");
      }
    }
    return this.fromGoal(missionGoalId, { missionId, taskId });
  }

  private async fromGoal(
    goalId: string | null,
    ids: { missionId: string; taskId?: string },
  ): Promise<ExecutionScope> {
    if (goalId === null) return executionScopeFromGoal({ ...ids, goalId: null, metadata: null });
    const stored = await this.deps.goals.getById(goalId);
    /*
     * A mission pointing at a goal that cannot be read has an UNKNOWN scope, which is not the
     * same as unscoped: treating it as unscoped would hand a client's work to an execution
     * with no client boundary. Refused.
     */
    if (!stored) throw new ExecutionScopeMismatchError("goal_not_found");
    return executionScopeFromGoal({ ...ids, goalId, metadata: stored.goal.metadata });
  }
}
