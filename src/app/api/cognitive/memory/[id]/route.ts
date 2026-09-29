import { z } from "zod";

import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { withCognitive } from "@/server/cognitive/http";

/**
 * GET: a memory and its supersession chain (provenance explanation).
 * DELETE: right to erasure — tombstone, content erased, provenance kept.
 * The client/project scope must be given explicitly (?clientId=&projectId=): a memory
 * outside the requested scope is indistinguishable from an unknown one.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const key = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]*$/)
  .max(200);
const scopeSchema = z.object({ clientId: key.nullable(), projectId: key.nullable() });

function scopeOf(request: Request) {
  const q = new URL(request.url).searchParams;
  return scopeSchema.safeParse({ clientId: q.get("clientId"), projectId: q.get("projectId") });
}

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
        route: "api.cognitive.memory.get",
        permission: "cockpit.read",
      }),
    async (rt, actor) => {
      const scope = scopeOf(request);
      if (!scope.success) return apiError("invalid_input", "périmètre invalide");
      const history = await rt.memoryHistory(actor, scope.data, id);
      return history.length
        ? json({ memory: history[0], history })
        : apiError("not_found", "mémoire introuvable");
    },
  );
}

export async function DELETE(
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
        route: "api.cognitive.memory.forget",
        permission: "tasks.write",
        sameOrigin: true,
      }),
    async (rt, actor) => {
      const scope = scopeOf(request);
      if (!scope.success) return apiError("invalid_input", "périmètre invalide");
      return (await rt.forgetMemory(actor, scope.data, id))
        ? json({ deleted: true })
        : apiError("not_found", "mémoire introuvable");
    },
  );
}
