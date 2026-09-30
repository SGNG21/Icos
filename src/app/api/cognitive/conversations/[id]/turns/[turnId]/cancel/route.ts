import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { withCognitive } from "@/server/cognitive/http";

/** Cancel an in-flight turn (durable status first, then the local model call is aborted). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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
        route: "api.cognitive.turns.cancel",
        permission: "tasks.write",
        sameOrigin: true,
      }),
    async (rt, actor) =>
      (await rt.cancelTurn(actor, id, turnId))
        ? json({ cancelled: true })
        : apiError("invalid_transition", "tour introuvable ou déjà terminé"),
  );
}
