import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { grantCapabilityBodySchema } from "@/server/http/capability-schemas";
import { CapabilityService } from "@/server/services/capability-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.agents.capabilities",
      permission: "agentCapabilities.read",
    });
    if (!access.ok) return access.response;

    const agentCapabilities = await container.agentCapabilities.listByAgent(id);
    return json({ agentCapabilities });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.agents.capabilities",
      permission: "agentCapabilities.write",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) return apiError("invalid_input", "corps JSON invalide");

    const parsed = grantCapabilityBodySchema.safeParse(body.value);
    if (!parsed.success)
      return apiError("invalid_input", "payload invalide", zodDetails(parsed.error));

    const service = new CapabilityService(
      container.capabilities,
      container.agentCapabilities,
      container.capabilityUow,
    );

    const result = await service.grantCapability({
      agentId: id,
      capabilityId: parsed.data.capabilityId,
      assignedByUserId: access.session.user.id,
      actorLabel: access.session.user.id,
    });

    if (!result.ok) {
      if (result.reason === "grant_failed") return apiError("invalid_input", result.message);
      return apiError("internal_error", result.message);
    }

    return json({ agentCapability: result.data }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
