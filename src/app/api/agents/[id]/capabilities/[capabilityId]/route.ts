import { getContainer } from "@/server/container";
import { apiError, json } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { CapabilityService } from "@/server/services/capability-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; capabilityId: string }> },
): Promise<Response> {
  try {
    const { capabilityId } = await params;
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.agents.capabilities",
      permission: "agentCapabilities.write",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const service = new CapabilityService(
      container.capabilities,
      container.agentCapabilities,
      container.audit,
    );

    const result = await service.revokeCapability({
      agentCapabilityId: capabilityId,
      actorLabel: access.session.user.id,
    });

    if (!result.ok) {
      if (result.reason === "not_found") return apiError("not_found", result.message);
      return apiError("internal_error", result.message);
    }

    return json({ revoked: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
