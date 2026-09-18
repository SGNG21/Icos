import type { MissionRepository } from "@/server/mission/ports";
import type { AutonomousMissionRuntimeRepository } from "@/server/autonomy/runtime";
import {
  AutonomousMissionRunner,
  type AutonomousMissionPlanner,
  type AutonomousSupervisor,
  type AutonomousMissionRunnerOptions,
  type AutonomousMissionRunnerResult,
} from "@/server/autonomy/autonomous-mission-runner";

/**
 * Phase 6 — Autonomous mission ignition.
 *
 * This is the single production entry point that makes "one objective is
 * enough". It does NOT introduce a second runner, planner or supervisor: it
 * composes the existing canonical `AutonomousMissionRunner` so that a freshly
 * created mission (objective + empty or seeded graph) begins executing without
 * any further manual step.
 *
 * Control flow after ignition is entirely owned by the existing pipeline:
 *   - runner bootstraps a durable runtime (createIfAbsent) and claims the lease;
 *   - initial planning (tasks.length === 0) calls the real planner and persists
 *     the validated DAG through the repository's atomic applyPlan();
 *   - the supervisor prepares + dispatches ready tasks through the durable
 *     dispatch ledger;
 *   - worker callbacks resume through AutonomyWakeupService;
 *   - quality control, correction, retry, replan, recovery and completion
 *     gating all remain the Phase 3/4/5 code paths.
 *
 * Invariants preserved:
 *   - ownership/fencing: the runner claims the runtime lease; a losing caller
 *     receives `waiting`/`AUTONOMY_RUNTIME_ALREADY_OWNED` and must not mutate;
 *   - budgets: cycle/runtime/stagnation/replan budgets are the runtime's own
 *     durable values, never widened here;
 *   - fail-closed: an unavailable planner surfaces as a thrown planner error,
 *     never an implicit empty plan or false success;
 *   - idempotency: re-igniting an existing runtime is safe — createIfAbsent is a
 *     no-op and the runner resumes the persisted runtime instead of resetting
 *     counters.
 */
export interface StartAutonomousMissionDeps {
  missions: Pick<MissionRepository, "findById" | "listTasks" | "applyPlan" | "replacePlan">;
  runtimeRepository: AutonomousMissionRuntimeRepository;
  supervisor: AutonomousSupervisor;
  planner: AutonomousMissionPlanner;
  options?: AutonomousMissionRunnerOptions;
  now?: () => Date;
}

export interface StartAutonomousMissionInput {
  missionId: string;
}

const DEFAULT_OPTIONS: AutonomousMissionRunnerOptions = {
  maxCycles: 100,
  maxRuntimeMs: 60 * 60 * 1000,
  maxStagnationCycles: 3,
  maxReplans: 5,
};

export async function startAutonomousMission(
  deps: StartAutonomousMissionDeps,
  input: StartAutonomousMissionInput,
): Promise<AutonomousMissionRunnerResult> {
  const mission = await deps.missions.findById(input.missionId);
  if (!mission) {
    throw new Error(`START_AUTONOMOUS_MISSION_NOT_FOUND:${input.missionId}`);
  }

  const runner = new AutonomousMissionRunner(
    deps.missions,
    deps.supervisor,
    deps.planner,
    deps.options ?? DEFAULT_OPTIONS,
    deps.now ?? (() => new Date()),
    deps.runtimeRepository,
  );

  return runner.run(input.missionId);
}
