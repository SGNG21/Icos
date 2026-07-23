import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { replaceRoleBodySchema } from "@/server/http/administration-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.users.role",
      permission: "users.role.write",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.humanAdministration) {
      return apiError("persistence_unavailable", "administration indisponible");
    }

    const { id } = await ctx.params;

    if (id === access.session.user.id) {
      return apiError("forbidden", "auto-modification interdite");
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = replaceRoleBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "rôle invalide", zodDetails(parsed.error));
    }

    const result = await container.humanAdministration.replaceRole({
      actorUserId: access.session.user.id,
      actorRoles: access.session.roles,
      targetUserId: id,
      ...parsed.data,
    });

    if (!result.ok) {
      return apiError(result.reason, result.message);
    }

    return json({ user: result.value });
  } catch (error) {
    return toErrorResponse(error);
  }
}
