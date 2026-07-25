import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";

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
      route: "api.skills.[id]",
      permission: "skills.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const { id } = await ctx.params;
    const result = await container.skillService!.getSkill(id);
    if (!result.ok) {
      return json({ error: result.reason, message: result.message }, { status: 404 });
    }

    return json({ skill: result.data.skill });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.skills.[id]",
      permission: "skills.delete",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    const { id } = await ctx.params;
    const result = await container.skillService!.deleteSkill(id, {
      actorKind: "human",
      actorLabel: access.session.user.id,
    });

    if (!result.ok) {
      return json({ error: result.reason, message: result.message }, { status: 400 });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
