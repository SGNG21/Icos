import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { createCapabilityBodySchema } from "@/server/http/capability-schemas";
import { CapabilityService } from "@/server/services/capability-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.capabilities",
      permission: "capabilities.read",
    });
    if (!access.ok) return access.response;

    const capabilities = await container.capabilities.list();
    return json({ capabilities });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.capabilities",
      permission: "capabilities.create",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) return apiError("invalid_input", "corps JSON invalide");

    const parsed = createCapabilityBodySchema.safeParse(body.value);
    if (!parsed.success)
      return apiError("invalid_input", "payload invalide", zodDetails(parsed.error));

    const service = new CapabilityService(
      container.capabilities,
      container.agentCapabilities,
      container.capabilityUow,
    );

    const result = await service.createCapability({
      ...parsed.data,
      actorLabel: access.session.user.id,
    });

    if (!result.ok) return apiError("invalid_input", result.message);

    return json({ capability: result.data }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
