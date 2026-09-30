import { z } from "zod";

import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { withCognitive } from "@/server/cognitive/http";

/** Memory candidates awaiting human review (model inferences, untrusted text, conflicts). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const key = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]*$/)
  .max(200);
const scopeSchema = z.object({ clientId: key.nullable(), projectId: key.nullable() });

export function GET(request: Request): Promise<Response> {
  return withCognitive(
    request,
    (container) =>
      protectRoute({
        container,
        request,
        route: "api.cognitive.memory.candidates",
        permission: "approvals.decide",
      }),
    async (rt, actor) => {
      const q = new URL(request.url).searchParams;
      const scope = scopeSchema.safeParse({
        clientId: q.get("clientId"),
        projectId: q.get("projectId"),
      });
      if (!scope.success) return apiError("invalid_input", "périmètre invalide");
      return json({ candidates: await rt.memoryCandidates(actor, scope.data) });
    },
  );
}
