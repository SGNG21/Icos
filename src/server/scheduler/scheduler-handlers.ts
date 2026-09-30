import type { ScheduledJobKind } from "@/core/contracts/scheduler";
import type { MissionRepository } from "@/server/mission/ports";
import { PermanentJobError, type JobHandler } from "@/server/scheduler/durable-scheduler";
import {
  igniteAutonomousMission,
  type IgniteAutonomousMissionDeps,
} from "@/server/usecases/ignite-autonomous-mission";
import { createObservationHandler } from "@/server/proactive/observations";
import {
  createWorkerProbeHandler,
  type WorkerProbeHandlerDeps,
} from "@/server/workers/probes/worker-probe-schedule";

export interface SchedulerHandlerDeps {
  ignite: IgniteAutonomousMissionDeps;
  missions: Pick<MissionRepository, "findById">;
  wakeup: { wake(missionId: string): Promise<unknown> };
  /**
   * Autonomous worker probing (M6, defect 16). Without it the `probe_workers`
   * handler refuses the job as a PERMANENT error rather than silently succeeding:
   * a deployment that scheduled probing but composed no prober has a
   * configuration defect, and a fleet whose evidence quietly expires looks like a
   * routing bug instead.
   */
  workerProbe?: WorkerProbeHandlerDeps;
  /**
   * Proactive Supervisor observations (decision 0060). Absent ⇒ the job fails
   * PERMANENTLY, never a silent success: an observation nobody runs must show up.
   */
  supervisorObservation?: Parameters<typeof createObservationHandler>[0];
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
      if (!missionId || !title || !objective) {
        throw new PermanentJobError("SCHEDULER_INVALID_PAYLOAD");
      }
      /*
       * goalId is OPTIONAL, matching igniteAutonomousMission's own contract.
       *
       * A scheduled job that names a goal produces a goal-backed autonomous
       * mission with plan lineage; one that does not produces a generic
       * mission (mission N11). A goalId is never invented to satisfy a
       * required field: fake lineage is worse than absent lineage.
       */
      const goalId = text(job.payload.goalId) ?? undefined;

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

    probe_workers: deps.workerProbe
      ? createWorkerProbeHandler(deps.workerProbe)
      : async () => {
          throw new PermanentJobError("SCHEDULER_WORKER_PROBE_UNAVAILABLE");
        },

    supervisor_observe: deps.supervisorObservation
      ? createObservationHandler(deps.supervisorObservation)
      : async () => {
          throw new PermanentJobError("SCHEDULER_SUPERVISOR_UNAVAILABLE");
        },
  };
}
