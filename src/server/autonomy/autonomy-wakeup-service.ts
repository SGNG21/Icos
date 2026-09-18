import type { MissionRepository } from "@/server/mission/ports";

import type { AutonomousMissionRuntimeRepository } from "@/server/autonomy/runtime";

import {
  AutonomousMissionRunner,
  type AutonomousMissionPlanner,
  type AutonomousSupervisor,
  type AutonomousMissionRunnerResult,
} from "@/server/autonomy/autonomous-mission-runner";

/**
 * Event-driven continuation bridge.
 *
 * Existing/non-autonomous missions retain the legacy Supervisor path.
 * Missions with a durable autonomous runtime resume through
 * AutonomousMissionRunner so counters, heartbeat and budgets remain coherent.
 */
export class AutonomyWakeupService {
  constructor(
    private readonly missions: Pick<
      MissionRepository,
      "findById" | "listTasks" | "applyPlan" | "replacePlan"
    >,
    private readonly supervisor: AutonomousSupervisor,
    private readonly runtimeRepository: AutonomousMissionRuntimeRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly planner?: AutonomousMissionPlanner,
  ) {}

  async wake(missionId: string): Promise<AutonomousMissionRunnerResult | null> {
    const runtime = await this.runtimeRepository.get(missionId);

    /*
     * No durable autonomous runtime:
     * preserve the pre-N2.7 continuation semantics.
     */
    if (!runtime) {
      await this.supervisor.run(missionId);

      return null;
    }

    /*
     * Production composition may provide the real planner so abandoned initial
     * planning and durable `replanning` states can recover through this same
     * canonical runner path. Tests and non-production composition retain a
     * fail-closed planner when none is explicitly supplied.
     */
    const wakeOnlyPlanner: AutonomousMissionPlanner = {
      async plan() {
        throw new Error("AUTONOMY_WAKEUP_PLANNER_UNAVAILABLE");
      },
    };

    const runner = new AutonomousMissionRunner(
      this.missions,
      this.supervisor,
      this.planner ?? wakeOnlyPlanner,

      /*
       * Existing persisted configuration wins inside the runner.
       * These values are only unreachable defaults for an existing runtime.
       */
      {
        maxCycles: runtime.maxCycles,
        maxRuntimeMs: runtime.maxRuntimeMs,
        maxStagnationCycles: runtime.maxStagnationCycles,
        maxReplans: runtime.maxReplans,
      },

      this.now,
      this.runtimeRepository,
    );

    return runner.run(missionId);
  }
}
