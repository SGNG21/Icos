import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { changeCapabilityStatusBodySchema } from "@/server/http/capability-schemas";
import { CapabilityService } from "@/server/services/capability-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.capabilities.status",
      permission: "capabilities.status.write",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) return apiError("invalid_input", "corps JSON invalide");

    const parsed = changeCapabilityStatusBodySchema.safeParse(body.value);
    if (!parsed.success) return apiError("invalid_input", "payload invalide", zodDetails(parsed.error));

    const service = new CapabilityService(
      container.capabilities,
      container.agentCapabilities,
      container.audit,
    );

    const result = await service.changeCapabilityStatus({
      capabilityId: id,
      targetStatus: parsed.data.status,
      actorLabel: access.session.user.id,
    });

    if (!result.ok) {
      if (result.reason === "not_found") return apiError("not_found", result.message);
      if (result.reason === "invalid_transition") return apiError("invalid_transition", result.message);
      return apiError("internal_error", result.message);
    }

    return json({ capability: result.data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
