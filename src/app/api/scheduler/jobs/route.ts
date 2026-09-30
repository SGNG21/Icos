import { getContainer } from "@/server/container";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import { toScheduledJobDto } from "@/server/scheduler/scheduled-job-dto";
import {
  RESERVED_KEY_PREFIX,
  SchedulerValidationError,
} from "@/server/scheduler/scheduler-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Durable Scheduler (ADR-0025) : enqueue d'un job différé.
 * 201 = créé, 200 = rejeu idempotent (même clé, même contenu), 409 = clé réutilisée
 * pour un autre contenu. PostgreSQL est la source de vérité ; l'exécution est
 * asynchrone (sweeper), jamais dans cette requête.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.scheduler.jobs.create",
      permission: "scheduler.manage",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) return apiError("invalid_input", "corps JSON invalide");

    const key = (body.value as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    if (typeof key === "string" && key.startsWith(RESERVED_KEY_PREFIX)) {
      return apiError("invalid_input", "clé d'idempotence réservée");
    }

    try {
      const { job, created } = await container.scheduler.enqueue(body.value);
      return json({ job: toScheduledJobDto(job) }, { status: created ? 201 : 200 });
    } catch (error) {
      if (error instanceof SchedulerValidationError) {
        return apiError("invalid_input", "job invalide", zodDetails(error.zodError));
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
