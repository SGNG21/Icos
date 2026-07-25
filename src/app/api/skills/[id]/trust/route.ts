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
      route: "api.skills.[id].trust",
      permission: "skills.trust.write",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    const { id } = await ctx.params;
    const body = await request.json();
    const { targetTrustState } = body;

    if (!targetTrustState) {
      return json({ error: "invalid_input", message: "targetTrustState is required" }, { status: 400 });
    }

    let result;
    switch (targetTrustState) {
      case "quarantined":
        result = await container.skillService!.quarantineSkill(id, {
          actorKind: "human",
          actorLabel: access.session.user.id,
        });
        break;
      case "reviewed":
        result = await container.skillService!.reviewSkill(id, {
          actorKind: "human",
          actorLabel: access.session.user.id,
        });
        break;
      case "approved":
        result = await container.skillService!.approveSkill(id, {
          actorKind: "human",
          actorLabel: access.session.user.id,
        });
        break;
      case "rejected":
        result = await container.skillService!.rejectSkillAction(id, {
          actorKind: "human",
          actorLabel: access.session.user.id,
        });
        break;
      default:
        return json({ error: "invalid_input", message: "Invalid targetTrustState" }, { status: 400 });
    }

    if (!result.ok) {
      const httpCode = result.reason === "not_found" ? 404 : result.reason === "human_only" ? 403 : 400;
      return json({ error: result.reason, message: result.message }, { status: httpCode });
    }

    return json({ skill: result.data.skill });
  } catch (error) {
    return toErrorResponse(error);
  }
}
