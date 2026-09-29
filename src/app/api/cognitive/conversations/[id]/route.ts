import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { withCognitive } from "@/server/cognitive/http";

/** Resume a conversation: full durable state (recovers turns interrupted by a restart). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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
        route: "api.cognitive.conversation.get",
        permission: "cockpit.read",
      }),
    async (rt, actor) => json(await rt.resume(actor, id)),
  );
}
