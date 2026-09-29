import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { withCognitive } from "@/server/cognitive/http";

/** The exact context supplied for a turn, and the memories it cited with their provenance. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; turnId: string }> },
): Promise<Response> {
  const { id, turnId } = await context.params;
  return withCognitive(
    request,
    (container) =>
      protectRoute({
        container,
        request,
        route: "api.cognitive.turns.context",
        permission: "cockpit.read",
      }),
    async (rt, actor) => {
      const ctx = await rt.getContext(actor, id, turnId);
      return ctx ? json(ctx) : apiError("not_found", "aucun contexte pour ce tour");
    },
  );
}
