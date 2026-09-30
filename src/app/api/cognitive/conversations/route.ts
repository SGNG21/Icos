import { createConversationSchema } from "@/core/cognitive/contracts";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { parseBody, withCognitive } from "@/server/cognitive/http";

/** Ask ICOS (decision 0057): list / create durable conversations of the current user. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return withCognitive(
    request,
    (container) =>
      protectRoute({
        container,
        request,
        route: "api.cognitive.conversations.list",
        permission: "cockpit.read",
      }),
    async (rt, actor) =>
      json({ conversations: await rt.listConversations(actor), engine: rt.engineLabel }),
  );
}

export function POST(request: Request): Promise<Response> {
  return withCognitive(
    request,
    (container) =>
      protectRoute({
        container,
        request,
        route: "api.cognitive.conversations.create",
        permission: "tasks.write",
        sameOrigin: true,
      }),
    async (rt, actor) => {
      const body = await parseBody(request, createConversationSchema);
      if (!body.ok) return body.response;
      return json(
        { conversation: await rt.createConversation(actor, body.value) },
        { status: 201 },
      );
    },
  );
}
