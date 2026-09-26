import { z } from "zod";

import { getContainer } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import { igniteAutonomousMission } from "@/server/usecases/ignite-autonomous-mission";

/**
 * Phase 6 — Autonomous mission ignition endpoint.
 *
 * This is the production "one objective is enough" entry path. A caller supplies
 * a single objective (and title); ICOS creates the mission with an empty graph
 * and starts the canonical AutonomousMissionRunner, which plans, dispatches and
 * then hands the loop to the existing event-driven pipeline
 * (callback → quality control → accept/correct/retry/replan → completion).
 *
 * Requires an authenticated ICOS session with the `tasks.write` permission
 * (operator and above); the proxy is never the security barrier.
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
    goalId: z.string(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed): nothing is read, parsed, created or revealed
    // (not even configuration state) before the ICOS session + permission are checked.
    // Same permission as POST /api/tasks: it launches real worker executions.
    const access = await protectRoute({
      container,
      request,
      route: "api.missions.autonomous.create",
      permission: "tasks.write",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

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

    // One objective is enough: the mission is created with an empty graph; the
    // runner's initial-planning branch produces and persists the validated DAG.
    const supervisor = new SupervisorService(
      container.mission,
      container.tasks,
      container.taskExecution,
      container.durableMemory,
      container.dispatchAttempts,
    );

    const result = await igniteAutonomousMission(
      {
        missions: container.mission,
        runtimeRepository: container.autonomousRuntime,
        supervisor,
        planner: container.autonomousPlanner,
      },
      { title: parsed.data.title, objective: parsed.data.objective, goalId: parsed.data.goalId },
    );

    // The mission and its durable runtime exist even when starting failed: the
    // recovery sweeper resumes it, so acknowledge with the missionId (never a bare 500
    // that would push the client to create a duplicate).
    if (result.outcome === "deferred") {
      return json(
        { missionId: result.missionId, state: "starting", reason: "AUTONOMY_START_DEFERRED" },
        { status: 202 },
      );
    }

    // 202: the mission is durably created and keeps running asynchronously.
    return json(
      { missionId: result.missionId, state: result.state, reason: result.reason },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
