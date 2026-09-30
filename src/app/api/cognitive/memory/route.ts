import { rememberSchema } from "@/core/cognitive/contracts";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { parseBody, withCognitive } from "@/server/cognitive/http";

/** Explicit "remember this" by an authenticated human: the only USER_ASSERTED write path. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return withCognitive(
    request,
    (container) =>
      protectRoute({
        container,
        request,
        route: "api.cognitive.memory.remember",
        permission: "tasks.write",
        sameOrigin: true,
      }),
    async (rt, actor) => {
      const body = await parseBody(request, rememberSchema);
      if (!body.ok) return body.response;
      const outcome = await rt.remember(actor, body.value);
      return json({ outcome }, { status: outcome.kind === "rejected" ? 422 : 200 });
    },
  );
}
