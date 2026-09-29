import { proposalDecisionSchema } from "@/core/cognitive/contracts";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { parseBody, withCognitive } from "@/server/cognitive/http";

/**
 * Human decision on a proposal (goal/mission or action). Approving a goal proposal hands
 * it to canonical goal intake (pending goal); it never starts a mission by itself.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; refId: string }> },
): Promise<Response> {
  const { id, refId } = await context.params;
  return withCognitive(
    request,
    (container) =>
      protectRoute({
        container,
        request,
        route: "api.cognitive.proposals.decide",
        permission: "missions.write",
        sameOrigin: true,
      }),
    async (rt, actor) => {
      const body = await parseBody(request, proposalDecisionSchema);
      if (!body.ok) return body.response;
      const res = await rt.decideProposal(actor, id, refId, body.value.decision);
      if (res.ok) return json({ proposal: res.proposal });
      return res.reason === "not_found"
        ? apiError("not_found", "proposition introuvable")
        : apiError("already_decided", "proposition déjà décidée");
    },
  );
}
