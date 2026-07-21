import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { zodDetails } from "@/server/http/errors";
import { transitionBodySchema } from "@/server/http/schemas";
import { transitionTask } from "@/server/usecases/transition-task";

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

    const parsed = transitionBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    const container = await getContainer();
    const result = await transitionTask(
      { tasks: container.tasks },
      { taskId: id, to: parsed.data.to },
    );

    if (!result.ok) {
      if (result.reason === "invalid_transition") {
        return apiError("invalid_transition", `transition ${result.from} → ${result.to} interdite`);
      }
      if (result.reason === "task_not_found") {
        return apiError("not_found", result.message);
      }
      return apiError("audit_failed", result.message);
    }

    return json({ task: result.task });
  } catch {
    return apiError("internal_error", "erreur interne");
  }
}
