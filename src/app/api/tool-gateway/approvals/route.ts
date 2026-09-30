import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { getToolGatewayRuntime, toolTenantOf } from "@/server/tool-gateway/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending tool approvals, with the exact input each one would run. Deciders only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tool-gateway.approvals",
      permission: "approvals.decide",
    });
    if (!access.ok) return access.response;
    const rt = await getToolGatewayRuntime(container);
    return json({ approvals: await rt.gateway.listPendingApprovals(toolTenantOf()) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
