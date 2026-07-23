import { getContainer } from "@/server/container";
import { apiError } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; agentId: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.users.agentLinks.agent",
      permission: "agentLinks.write",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.humanAdministration) {
      return apiError("persistence_unavailable", "administration indisponible");
    }

    const { id, agentId } = await ctx.params;

    if (id === access.session.user.id) {
      return apiError("forbidden", "auto-modification interdite");
    }

    const result = await container.humanAdministration.removeLink({
      actorUserId: access.session.user.id,
      actorRoles: access.session.roles,
      targetUserId: id,
      agentId,
    });

    if (!result.ok) {
      return apiError(result.reason, result.message);
    }

    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
