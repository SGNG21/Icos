import { getContainer } from "@/server/container";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import { getToolGatewayRuntime, toolTenantOf } from "@/server/tool-gateway/app";
import {
  approvalDecisionBodySchema,
  principalOf,
  toolFailureResponse,
} from "@/server/tool-gateway/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approve or reject ONE tool approval request. The decider is the session user
 * (persisted as `decidedBy`); the body cannot name anyone. Execution still
 * happens only when the requester retries with the same key and payload.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tool-gateway.approvals.decision",
      permission: "approvals.decide",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) return apiError("invalid_input", "corps JSON invalide");
    const parsed = approvalDecisionBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "décision invalide", zodDetails(parsed.error));
    }

    const { id } = await ctx.params;
    const rt = await getToolGatewayRuntime(container);
    const result = await rt.gateway.decideApproval(
      toolTenantOf(),
      id,
      principalOf(access.session),
      parsed.data.decision,
      parsed.data.reason,
    );
    if (!result.ok) return toolFailureResponse(result.failureClass, result.message);
    return json({ approval: result.request });
  } catch (error) {
    return toErrorResponse(error);
  }
}
