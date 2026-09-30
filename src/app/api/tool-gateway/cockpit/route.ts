import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { getToolGatewayRuntime, toolTenantOf } from "@/server/tool-gateway/app";
import { cockpitView } from "@/server/tool-gateway/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only Tool Gateway snapshot for the Cockpit: inventory, dated connector
 * health, rate limits, executions, failures, blocked actions, side effects,
 * pending approvals (without input previews). No secret is ever part of it.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tool-gateway.cockpit",
      permission: "cockpit.read",
    });
    if (!access.ok) return access.response;
    const rt = await getToolGatewayRuntime(container);
    const tenantId = toolTenantOf();
    const [snapshot, inventory] = await Promise.all([
      rt.gateway.cockpitSnapshot(tenantId),
      // Catalogue view (no agent grants): what exists, its risk and approval rules.
      rt.gateway.inventory({ tenantId, agentId: "cockpit-viewer" }),
    ]);
    const catalogue = inventory.connectors.map((c) => ({
      ...c,
      tools: c.tools.map((t) => ({
        ...t,
        actions: t.actions.map(({ permitted: _permitted, ...a }) => {
          void _permitted;
          return a;
        }),
      })),
    }));
    return json({ ...cockpitView(snapshot), inventory: catalogue });
  } catch (error) {
    return toErrorResponse(error);
  }
}
