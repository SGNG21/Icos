import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { createAgentLinkBodySchema } from "@/server/http/administration-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.users.agentLinks",
      permission: "agentLinks.read",
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.humanAdministration) {
      return apiError("persistence_unavailable", "administration indisponible");
    }

    const { id } = await ctx.params;

    const result = await container.humanAdministration.listLinks({
      actorUserId: access.session.user.id,
      actorRoles: access.session.roles,
      targetUserId: id,
    });

    if (!result.ok) {
      return apiError(result.reason, result.message);
    }

    return json({ links: result.value });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.users.agentLinks",
      permission: "agentLinks.write",
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

    const parsed = createAgentLinkBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "lien invalide", zodDetails(parsed.error));
    }

    const result = await container.humanAdministration.createLink({
      actorUserId: access.session.user.id,
      actorRoles: access.session.roles,
      targetUserId: id,
      ...parsed.data,
    });

    if (!result.ok) {
      return apiError(result.reason, result.message);
    }

    return json({ link: result.value }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
