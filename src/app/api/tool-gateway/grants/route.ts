import { getContainer } from "@/server/container";
import { zodDetails } from "@/server/http/errors";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import { getToolGatewayRuntime, toolTenantOf } from "@/server/tool-gateway/app";
import { grantBodySchema, principalOf, toolFailureResponse } from "@/server/tool-gateway/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Inspect tool grants (active and revoked, with grantor and reasons). */
export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tool-gateway.grants",
      permission: "agentCapabilities.read",
    });
    if (!access.ok) return access.response;
    const agentId = new URL(request.url).searchParams.get("agentId") ?? undefined;
    const rt = await getToolGatewayRuntime(container);
    return json({ grants: await rt.gateway.listGrants(toolTenantOf(), agentId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * Grant or revoke one exact tool action for one agent. Same authority as
 * assigning capabilities to agents (`agentCapabilities.write`); the grantor is
 * the session user. Agents have no session here: they cannot grant anything.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tool-gateway.grants",
      permission: "agentCapabilities.write",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const body = await readJson(request);
    if (!body.ok) return apiError("invalid_input", "corps JSON invalide");
    const parsed = grantBodySchema.safeParse(body.value);
    if (!parsed.success)
      return apiError("invalid_input", "grant invalide", zodDetails(parsed.error));

    const { op, ...grant } = parsed.data;
    const rt = await getToolGatewayRuntime(container);
    const result = await rt.gateway.setGrant(
      principalOf(access.session),
      { ...grant, tenantId: toolTenantOf() },
      op,
    );
    if (!result.ok) return toolFailureResponse(result.failureClass, result.message);
    return json({ ok: true, grant: result.grant ?? null }, { status: op === "grant" ? 201 : 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
