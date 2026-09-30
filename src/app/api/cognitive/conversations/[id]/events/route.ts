import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { withCognitive } from "@/server/cognitive/http";

/**
 * Conversation event stream, read from the durable append-only log (restart-safe).
 * `Accept: text/event-stream` → SSE (resumable with Last-Event-ID / ?after=, closes after
 * ~25 s so the client reconnects); otherwise a JSON page of events after `?after=`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 500;
const STREAM_MS = 25_000;

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
        route: "api.cognitive.events",
        permission: "cockpit.read",
      }),
    async (rt, actor) => {
      const raw =
        request.headers.get("last-event-id") ??
        new URL(request.url).searchParams.get("after") ??
        "0";
      const after = Number(raw);
      if (!Number.isInteger(after) || after < 0)
        return apiError("invalid_input", "curseur invalide");
      const first = await rt.events(actor, id, after); // also enforces ownership (404)
      if (!request.headers.get("accept")?.includes("text/event-stream"))
        return json({ events: first });

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let cursor = after;
          let batch = first;
          const deadline = Date.now() + STREAM_MS;
          try {
            while (!request.signal.aborted) {
              for (const e of batch) {
                controller.enqueue(
                  encoder.encode(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
                );
                cursor = e.seq;
              }
              if (Date.now() > deadline) break;
              await new Promise((r) => setTimeout(r, POLL_MS));
              batch = await rt.events(actor, id, cursor);
            }
          } catch {
            controller.enqueue(encoder.encode("event: error\ndata: {}\n\n"));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
    },
  );
}
