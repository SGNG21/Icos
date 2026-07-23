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

    return json({ agents: await container.agents.list() });
  } catch (error) {
    return toErrorResponse(error);
  }
}
