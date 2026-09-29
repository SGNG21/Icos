import { submitTurnSchema } from "@/core/cognitive/contracts";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { parseBody, withCognitive } from "@/server/cognitive/http";

/**
 * Submit a user turn. Idempotent on `idempotencyKey` (a replay returns the original turn,
 * 200 + `replayed: true`); a second concurrent turn is refused with 409. Progress is also
 * observable on GET …/events (SSE).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return withCognitive(
    request,
    (container) =>
      protectRoute({
        container,
        request,
        route: "api.cognitive.turns.submit",
        permission: "tasks.write",
        sameOrigin: true,
      }),
    async (rt, actor) => {
      const body = await parseBody(request, submitTurnSchema);
      if (!body.ok) return body.response;
      const result = await rt.submitTurn(actor, id, body.value);
      return json(result, { status: result.replayed ? 200 : 201 });
    },
  );
}
