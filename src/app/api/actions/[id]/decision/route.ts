import { actionDecisionCommandSchema } from "@/core/contracts";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { resolveOperationalScope } from "@/server/administration/mission-scope";
import { zodDetails } from "@/server/http/errors";
import { apiError, json, readJson } from "@/server/http/respond";
import { recordActionDecision } from "@/server/usecases/record-action-decision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.actions.decision",
      permission: "approvals.decide",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    const { id } = await ctx.params;
    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = actionDecisionCommandSchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "décision invalide", zodDetails(parsed.error));
    }

    const scope = await resolveOperationalScope(container, access.session);

    if (!(await container.actions.getByIdForScope(id, scope))) {
      return apiError("not_found", "action introuvable");
    }

    const result = await recordActionDecision(
      {
        actions: container.actions,
        agents: container.agents,
        tasks: container.tasks,
        uow: container.decisionUow,
      },
      {
        actionId: id,
        command: parsed.data,
        /*
         * The decider is the SESSION user, never a label from the body. Same rule as
         * /api/tool-gateway/approvals/[id]/decision: an approver identity cannot be forged.
         */
        decider: { kind: "human", id: access.session.user.id },
      },
    );

    if (!result.ok) {
      if (result.reason === "action_not_found") {
        return apiError("not_found", result.message);
      }
      return apiError(result.reason, result.message);
    }

    return json({ approval: result.approval, action: result.action, execution: result.execution });
  } catch (error) {
    return toErrorResponse(error);
  }
}