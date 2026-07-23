import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { createHumanBodySchema } from "@/server/http/administration-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.users",
      permission: "users.read",
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.humanAdministration) {
      return apiError("persistence_unavailable", "administration indisponible");
    }

    const users = await container.humanAdministration.listUsers();
    return json({ users });
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
      route: "api.admin.users",
      permission: "users.create",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.humanAdministration) {
      return apiError("persistence_unavailable", "administration indisponible");
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = createHumanBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "utilisateur invalide", zodDetails(parsed.error));
    }

    const result = await container.humanAdministration.createHuman({
      actorUserId: access.session.user.id,
      actorRoles: access.session.roles,
      ...parsed.data,
    });

    if (!result.ok) {
      return apiError(result.reason, result.message);
    }

    return json({ user: result.value }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
