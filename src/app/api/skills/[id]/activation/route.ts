import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";

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
      route: "api.skills.[id].activation",
      permission: "skills.activation.write",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    const { id } = await ctx.params;
    const body = await request.json();
    const { targetActivationState } = body;

    if (!targetActivationState) {
      return json(
        { error: "invalid_input", message: "targetActivationState is required" },
        { status: 400 },
      );
    }

    let result;
    switch (targetActivationState) {
      case "active":
        result = await container.skillService!.activateSkill(id, {
          actorKind: "human",
          actorLabel: access.session.user.id,
        });
        break;
      case "suspended":
        result = await container.skillService!.suspendSkill(id, {
          actorKind: "human",
          actorLabel: access.session.user.id,
        });
        break;
      case "revoked":
        result = await container.skillService!.revokeSkill(id, {
          actorKind: "human",
          actorLabel: access.session.user.id,
        });
        break;
      default:
        return json(
          { error: "invalid_input", message: "Invalid targetActivationState" },
          { status: 400 },
        );
    }

    if (!result.ok) {
      const httpCode =
        result.reason === "not_found" ? 404 : result.reason === "human_only" ? 403 : 400;
      return json({ error: result.reason, message: result.message }, { status: httpCode });
    }

    return json({ skill: result.data.skill });
  } catch (error) {
    return toErrorResponse(error);
  }
}
