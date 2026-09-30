import { z } from "zod";

import { memoryReviewSchema } from "@/core/cognitive/contracts";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { parseBody, withCognitive } from "@/server/cognitive/http";

/**
 * Human review of a memory candidate: accept (→ active, `reviewedBy` recorded, epistemic
 * unchanged) or reject. The only path by which a model inference becomes usable context.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const key = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]*$/)
  .max(200);
const scopeSchema = z.object({ clientId: key.nullable(), projectId: key.nullable() });

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
        route: "api.cognitive.memory.review",
        permission: "approvals.decide",
        sameOrigin: true,
      }),
    async (rt, actor) => {
      const q = new URL(request.url).searchParams;
      const scope = scopeSchema.safeParse({
        clientId: q.get("clientId"),
        projectId: q.get("projectId"),
      });
      if (!scope.success) return apiError("invalid_input", "périmètre invalide");
      const body = await parseBody(request, memoryReviewSchema);
      if (!body.ok) return body.response;
      const reviewed = await rt.reviewMemory(actor, scope.data, id, body.value.decision);
      return reviewed
        ? json({ memory: reviewed })
        : apiError("invalid_transition", "candidat introuvable ou déjà revu");
    },
  );
}
