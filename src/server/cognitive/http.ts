import type { ZodType } from "zod";

import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity";
import { getContainer, type Container } from "@/server/container";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import type { ProtectedRouteResult } from "@/server/http/protect-route";
import { apiError, readJson } from "@/server/http/respond";

import {
  ConversationNotFoundError,
  cognitiveRuntimeFor,
  TurnInProgressError,
  type CognitiveActor,
  type CognitiveRuntime,
} from "./index";

/**
 * Shared guard for /api/cognitive/* (decision 0057). Authorization FIRST (fail closed),
 * then the PostgreSQL-only runtime (503 in memory mode), then the handler. The tenant is
 * the single-tenant shim until COMPLIANCE-1 provides a TenantContext.
 */
export async function withCognitive(
  request: Request,
  authorize: (container: Container) => Promise<ProtectedRouteResult>,
  handler: (runtime: CognitiveRuntime, actor: CognitiveActor) => Promise<Response>,
): Promise<Response> {
  try {
    const container = await getContainer();
    // Each route passes its own protectRoute(...) call: the guard stays visible per handler.
    const access = await authorize(container);
    if (!access.ok) return access.response;
    const runtime = cognitiveRuntimeFor(container);
    if (!runtime)
      return apiError(
        "persistence_unavailable",
        "runtime cognitif indisponible (PostgreSQL requis)",
      );
    const actor: CognitiveActor = {
      tenantId: CURRENT_SINGLE_TENANT_ID,
      userId: access.session.user.id,
      roles: access.session.roles,
    };
    return await handler(runtime, actor);
  } catch (error) {
    if (error instanceof ConversationNotFoundError)
      return apiError("not_found", "conversation introuvable");
    if (error instanceof TurnInProgressError)
      return apiError("invalid_transition", "un tour est déjà en cours");
    return toErrorResponse(error);
  }
}

/** Parses a JSON body with a strict schema; returns the 400 response on failure. */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const body = await readJson(request);
  if (!body.ok) return { ok: false, response: apiError("invalid_input", "corps JSON invalide") };
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      response: apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error)),
    };
  }
  return { ok: true, value: parsed.data };
}
