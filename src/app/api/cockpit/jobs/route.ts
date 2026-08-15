import { z } from "zod";

import {
  COCKPIT_MAX_OBJECTIVE_LENGTH,
  CockpitJobCapacityError,
  CockpitJobConflictError,
} from "@/server/cockpit/job-registry";
import { getCockpitRuntime } from "@/server/cockpit/runtime";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createCockpitJobBodySchema = z
  .object({
    objective: z.string().trim().min(1).max(COCKPIT_MAX_OBJECTIVE_LENGTH),
  })
  .strict();

const idempotencyKeySchema = z.uuid();

function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function cockpitError(
  code: "idempotency_conflict" | "capacity_exhausted",
  message: string,
  status: 409 | 503,
): Response {
  return json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.cockpit.jobs",
      role: "operator",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!isJsonRequest(request)) {
      return apiError("invalid_input", "Le corps doit être du JSON.");
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = createCockpitJobBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides");
    }

    const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    if (!idempotencyKey.success) {
      return apiError("invalid_input", "Idempotency-Key UUID requis.");
    }

    const tenant = await container.tenantResolver.resolve({
      session: { userId: access.session.user.id },
      headers: request.headers,
    });
    if (!tenant.ok) {
      return apiError("forbidden", "Accès interdit.");
    }

    try {
      const job = await getCockpitRuntime().submitJob({
        tenantId: tenant.context.tenantId,
        idempotencyKey: idempotencyKey.data,
        objective: parsed.data.objective,
        requester: {
          kind: "human",
          id: access.session.user.id,
        },
      });
      return json({ job }, { status: 202 });
    } catch (error) {
      if (error instanceof CockpitJobConflictError) {
        return cockpitError(
          "idempotency_conflict",
          "Cette clé d'idempotence est déjà utilisée pour une autre requête.",
          409,
        );
      }
      if (error instanceof CockpitJobCapacityError) {
        return cockpitError(
          "capacity_exhausted",
          "La capacité locale des jobs Cockpit est temporairement épuisée.",
          503,
        );
      }
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
