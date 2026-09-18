import { z } from "zod";

import { getContainer } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import { apiError, json, readJson } from "@/server/http/respond";
import { startAutonomousMission } from "@/server/usecases/start-autonomous-mission";

/**
 * Phase 6 — Autonomous mission ignition endpoint.
 *
 * This is the production "one objective is enough" entry path. A caller supplies
 * a single objective (and title); ICOS creates the mission with an empty graph
 * and starts the canonical AutonomousMissionRunner, which plans, dispatches and
 * then hands the loop to the existing event-driven pipeline
 * (callback → quality control → accept/correct/retry/replan → completion).
 *
 * The endpoint requires the durable autonomous runtime AND a configured
 * production planner. If either is absent it fails closed rather than silently
 * degrading to a non-autonomous mission.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startAutonomousMissionBodySchema = z
  .object({
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    if (!container.autonomousRuntime) {
      return apiError("persistence_unavailable", "runtime autonome indisponible");
    }
    if (!container.autonomousPlanner) {
      return apiError("persistence_unavailable", "planificateur autonome non configuré");
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = startAutonomousMissionBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    // One objective is enough: mission is created with an empty graph; the
    // runner's initial-planning branch produces and persists the validated DAG.
    const mission = await container.mission.create({
      title: parsed.data.title,
      objective: parsed.data.objective,
      tasks: [],
    });

    const supervisor = new SupervisorService(
      container.mission,
      container.tasks,
      container.taskExecution,
      container.durableMemory,
      container.dispatchAttempts,
    );

    let result;
    try {
      result = await startAutonomousMission(
        {
          missions: container.mission,
          runtimeRepository: container.autonomousRuntime,
          supervisor,
          planner: container.autonomousPlanner,
        },
        { missionId: mission.id },
      );
    } catch (error) {
      // The mission and its durable runtime are already committed: the recovery
      // sweeper resumes planning/dispatch (e.g. after a transient planner or
      // provider error). Answering 500 here made clients retry and create a
      // duplicate mission, so acknowledge with the missionId instead.
      const runtime = await container.autonomousRuntime.get(mission.id).catch(() => null);
      if (runtime && !["succeeded", "failed", "cancelled", "escalated"].includes(runtime.state)) {
        const name = error instanceof Error ? error.name : typeof error;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[api] autonomous start deferred ${name}: ${message.slice(0, 300)}`);
        return json(
          { missionId: mission.id, state: "starting", reason: "AUTONOMY_START_DEFERRED" },
          { status: 202 },
        );
      }
      throw error;
    }

    return json({
      missionId: mission.id,
      state: result.state,
      reason: result.reason,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
