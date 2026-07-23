import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.agents",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const scope = container.operationalAccess
      ? await container.operationalAccess.resolveScope(access.session)
      : { kind: "global" as const };

    return json({ agents: await container.agents.listForScope(scope) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
