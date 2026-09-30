import { controlCommandRequestSchema } from "@/core/control/contracts";
import { getContainer } from "@/server/container";
import { auditInvalidRequest, resolveActor, statusForResult } from "@/server/control/http";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";

/**
 * POST /api/control/commands — the ONLY way to change control state (decision 0055).
 *
 * Route-level: authenticated session with cockpit.read, same-origin (CSRF).
 * Everything else — per-command permission, scope, risk, re-auth, version,
 * idempotency, audit — is decided by the ControlCommandBus.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.control.commands",
      permission: "cockpit.read",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const actor = await resolveActor(container, request.headers, access.session);
    if (!actor.ok) return actor.response;

    const body = await readJson(request);
    const parsed = body.ok ? controlCommandRequestSchema.safeParse(body.value) : null;
    if (!parsed?.success) {
      const details = parsed ? zodDetails(parsed.error) : "body is not JSON";
      const auditEntryId = await auditInvalidRequest(container, access.session.user.id, details);
      return apiError("invalid_input", "invalid control command", { details, auditEntryId });
    }

    const result = await container.control!.bus.execute(actor.actor, parsed.data);
    return json(result, { status: statusForResult(result) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
