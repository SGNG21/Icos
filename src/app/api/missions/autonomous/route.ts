import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { getContainer } from "@/server/container";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import {
  RESERVED_KEY_PREFIX,
  SchedulerValidationError,
} from "@/server/scheduler/scheduler-service";

/**
 * Autonomous mission ignition — an ENQUEUE, never an execution.
 *
 * ONE autonomous execution authority (P0, 2026-09-30). This route used to build its own
 * `SupervisorService` WITHOUT the governed workspace coordinator and await the whole
 * `AutonomousMissionRunner` inside the HTTP request: a writer task launched here ran on the
 * ungoverned dispatch path (no registered workspace, no gate, no reaping), and the mission's
 * first execution lived and died with the connection.
 *
 * It now only records the intent: a durable `start_mission` job. The Durable Scheduler runs it
 * through the canonical composition (`composeAutonomyRuntime` → governed supervisor with the
 * workspace coordinator, leases, fencing), exactly like a job enqueued via /api/scheduler/jobs.
 * 202 means "durably accepted"; the mission id is fixed at enqueue, so the caller can follow it.
 *
 * Idempotent: an `Idempotency-Key` header (or `idempotencyKey` in the body), scoped to the
 * caller, returns the SAME job and mission id on a retry; the same key for different content
 * is 409. Without a key every call is a new mission, as before.
 *
 * RUNS WHERE THE DURABLE SCHEDULER RUNS: `startProductionServices` (NODE_ENV=production,
 * PERSISTENCE=postgres). Elsewhere the job is accepted and waits — the endpoint no longer runs
 * a mission inside a request in any mode. The mission row appears when the job runs; start
 * failures are on the job (`lastError`), not in this response.
 *
 * Requires an authenticated ICOS session with `tasks.write`. Fails closed (503) when the
 * durable autonomous runtime or the planner is not configured, rather than accepting a mission
 * nothing could run.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startAutonomousMissionBodySchema = z
  .object({
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    goalId: z.string(),
    idempotencyKey: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed): nothing is read, parsed, created or revealed
    // (not even configuration state) before the ICOS session + permission are checked.
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
    if (!body.ok) return apiError("invalid_input", "corps JSON invalide");

    const parsed = startAutonomousMissionBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    const callerKey = request.headers.get("idempotency-key")?.trim() || parsed.data.idempotencyKey;
    try {
      /* Scoped to the caller: one user's key can never replay another user's mission. */
      /* Hashed: any caller key fits the scheduler's key length, and none is stored verbatim. */
      const idempotencyKey = `${RESERVED_KEY_PREFIX}${access.session.user.id}:${createHash("sha256")
        .update(callerKey ?? randomUUID())
        .digest("hex")}`;

      /*
       * Objective admission (decision 0065): the goal is SCORED and the portfolio is
       * consulted before the EXISTING start_mission job is enqueued. A deferred admission
       * still returns 202 with a durable job and mission id — the scheduler brings it back.
       *
       * A goalId that names no stored goal falls back to the plain enqueue: there is
       * nothing to score, and inventing a goal to score would be worse than ordering the
       * launch at the default priority.
       */
      const stored = await container.goalRepository.getById(parsed.data.goalId);
      const admitted = stored
        ? await container.objectiveCoordinator.admit({
            goal: stored.goal,
            idempotencyKey,
            title: parsed.data.title,
            objective: parsed.data.objective,
          })
        : null;

      const { job, created } = admitted
        ? {
            job: {
              id: admitted.jobId,
              missionId: admitted.missionId,
              payload: {} as Record<string, unknown>,
            },
            created: admitted.created,
          }
        : await container.scheduler.enqueue({
            kind: "start_mission",
            payload: {
              title: parsed.data.title,
              objective: parsed.data.objective,
              ...(parsed.data.goalId ? { goalId: parsed.data.goalId } : {}),
            },
            idempotencyKey,
          });
      return json(
        {
          missionId: job.missionId ?? (job.payload.missionId as string),
          jobId: job.id,
          state: "scheduled",
          replayed: !created,
        },
        { status: 202 },
      );
    } catch (error) {
      if (error instanceof SchedulerValidationError) {
        return apiError("invalid_input", "paramètres invalides", zodDetails(error.zodError));
      }
      if (error instanceof Error && error.message === "SCHEDULER_IDEMPOTENCY_CONFLICT") {
        return apiError("already_exists", "clé d'idempotence déjà utilisée pour un autre contenu");
      }
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
