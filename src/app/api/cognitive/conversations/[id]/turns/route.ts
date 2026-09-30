import { submitTurnSchema } from "@/core/cognitive/contracts";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { parseBody, withCognitive } from "@/server/cognitive/http";

/**
 * Submit a user turn. Idempotent on `idempotencyKey`; a second concurrent turn → 409.
 *
 * - default: blocks until the turn is terminal (201, or 200 + `replayed: true`);
 * - `?mode=accept` or `Prefer: respond-async` (Voice / phone): 202 as soon as the turn is
 *   durable, with its id and the event stream to follow. Processing continues server-side
 *   and is never cancelled by a dropped connection — only by POST …/cancel.
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
      const accept =
        new URL(request.url).searchParams.get("mode") === "accept" ||
        /\brespond-async\b/i.test(request.headers.get("prefer") ?? "");
      if (accept) {
        const accepted = await rt.acceptTurn(actor, id, body.value);
        return json(
          { ...accepted, events: `/api/cognitive/conversations/${id}/events?after=0` },
          { status: 202 },
        );
      }
      const result = await rt.submitTurn(actor, id, body.value);
      return json(result, { status: result.replayed ? 200 : 201 });
    },
  );
}
