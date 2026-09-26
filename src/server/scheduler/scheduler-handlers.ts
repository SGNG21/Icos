import type { ScheduledJobKind } from "@/core/contracts/scheduler";
import type { MissionRepository } from "@/server/mission/ports";
import { PermanentJobError, type JobHandler } from "@/server/scheduler/durable-scheduler";
import {
  igniteAutonomousMission,
  type IgniteAutonomousMissionDeps,
} from "@/server/usecases/ignite-autonomous-mission";

export interface SchedulerHandlerDeps {
  ignite: IgniteAutonomousMissionDeps;
  missions: Pick<MissionRepository, "findById">;
  wakeup: { wake(missionId: string): Promise<unknown> };
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/**
 * Job handlers of the Durable Scheduler. Both only create/wake a Mission: planning and
 * dispatch stay with the runner + Supervisor (dispatch ledger). Both are replay-safe,
 * because the scheduler is at-least-once (a crash can re-run a job).
 */
export function createSchedulerHandlers(deps: SchedulerHandlerDeps): Record<ScheduledJobKind, JobHandler> {
  return {
    async start_mission(job) {
      const missionId = text(job.payload.missionId);
      const title = text(job.payload.title);
      const objective = text(job.payload.objective);
      const goalId = text(job.payload.goalId);
      if (!missionId || !title || !objective || !goalId) {
        throw new PermanentJobError("SCHEDULER_INVALID_PAYLOAD");
      }
      // Fixed Mission id + idempotent create: a replay never creates a second Mission.
      await igniteAutonomousMission(deps.ignite, { id: missionId, title, objective, goalId });
    },

    async wake_mission(job) {
      const missionId = text(job.payload.missionId);
      if (!missionId) throw new PermanentJobError("SCHEDULER_INVALID_PAYLOAD");
      if (!(await deps.missions.findById(missionId))) {
        throw new PermanentJobError("SCHEDULER_MISSION_NOT_FOUND");
      }
      await deps.wakeup.wake(missionId);
    },
  };
}
