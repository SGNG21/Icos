import type { AutonomousMissionRuntimeRepository } from "@/server/autonomy/runtime";
import type { AutonomousMissionPlanner, AutonomousSupervisor } from "@/server/autonomy/autonomous-mission-runner";
import type { MissionRepository } from "@/server/mission/ports";
import {
  startAutonomousMission,
  type AutonomyCompositionPolicy,
  type StartAutonomousMissionInput,
} from "@/server/usecases/start-autonomous-mission";

/**
 * La politique de composition (plafond du déploiement + pool de compute système) est
 * TRANSPORTÉE, pas reconstruite: elle vient du conteneur et n'est interprétée qu'à
 * l'allumage. Absente = plafond historique et compute non restreint.
 */
export interface IgniteAutonomousMissionDeps extends AutonomyCompositionPolicy {
  missions: Pick<MissionRepository, "create" | "findById" | "listTasks" | "applyPlan" | "replacePlan">;
  runtimeRepository: AutonomousMissionRuntimeRepository;
  supervisor: AutonomousSupervisor;
  planner: AutonomousMissionPlanner;
}

export type IgniteAutonomousMissionResult =
  | { missionId: string; outcome: "started"; state: string; reason: string }
  | { missionId: string; outcome: "deferred" };

const TERMINAL_RUNTIME_STATES = ["succeeded", "failed", "cancelled", "escalated"];

/**
 * Creates a Mission with an empty graph (idempotent when `id` is imposed) and starts
 * the canonical AutonomousMissionRunner. Called ONLY by the Durable Scheduler's
 * `start_mission` job, with the governed supervisor of the canonical runtime composition;
 * POST /api/missions/autonomous enqueues that job and never calls this (P0, 2026-09-30).
 * Replay-safe:
 *
 * - the Mission id can be fixed up front, so a replay after a crash never creates a
 *   second Mission;
 * - if starting fails AFTER the Mission and its durable runtime exist (e.g. transient
 *   planner/provider error), the recovery sweeper resumes it: the result is `deferred`,
 *   never an error that would push a caller to create a duplicate.
 */
export async function igniteAutonomousMission(
  deps: IgniteAutonomousMissionDeps,
  input: { id?: string; title: string; objective: string; goalId?: string } & Pick<
    StartAutonomousMissionInput,
    "bounds" | "computePolicy"
  >,
): Promise<IgniteAutonomousMissionResult> {
  const mission = await deps.missions.create({
    ...(input.id !== undefined ? { id: input.id } : {}),
    title: input.title,
    objective: input.objective,
    goalId: input.goalId ?? undefined,
    tasks: [],
  });

  try {
    const result = await startAutonomousMission(
      {
        missions: deps.missions,
        runtimeRepository: deps.runtimeRepository,
        supervisor: deps.supervisor,
        planner: deps.planner,
        ...(deps.options !== undefined ? { options: deps.options } : {}),
        ...(deps.systemModelAllowlist !== undefined
          ? { systemModelAllowlist: deps.systemModelAllowlist }
          : {}),
        ...(deps.plannerCompute !== undefined ? { plannerCompute: deps.plannerCompute } : {}),
      },
      {
        missionId: mission.id,
        /* Les bornes et le pool demandés traversent tels quels; l'allumage les résout. */
        ...(input.bounds !== undefined ? { bounds: input.bounds } : {}),
        ...(input.computePolicy !== undefined ? { computePolicy: input.computePolicy } : {}),
      },
    );
    return { missionId: mission.id, outcome: "started", state: result.state, reason: result.reason };
  } catch (error) {
    const runtime = await deps.runtimeRepository.get(mission.id).catch(() => null);
    if (runtime && !TERMINAL_RUNTIME_STATES.includes(runtime.state)) {
      const name = error instanceof Error ? error.name : typeof error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[api] autonomous start deferred ${name}: ${message.slice(0, 300)}`);
      return { missionId: mission.id, outcome: "deferred" };
    }
    throw error;
  }
}