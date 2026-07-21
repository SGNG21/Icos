import { actionDecisionCommandSchema } from "@/core/contracts";
import { getContainer } from "@/server/container";
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
    const { id } = await ctx.params;

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = actionDecisionCommandSchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "décision invalide", zodDetails(parsed.error));
    }

    const container = await getContainer();
    const result = await recordActionDecision(
      {
        actions: container.actions,
        agents: container.agents,
        tasks: container.tasks,
        uow: container.decisionUow,
      },
      { actionId: id, command: parsed.data },
    );

    if (!result.ok) {
      if (result.reason === "action_not_found") {
        return apiError("not_found", result.message);
      }
      return apiError(result.reason, result.message);
    }

    return json({ approval: result.approval, action: result.action, execution: result.execution });
  } catch {
    return apiError("internal_error", "erreur interne");
  }
}
