import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { resolveOperationalScope } from "@/server/administration/mission-scope";
import { apiError, json } from "@/server/http/respond";

/**
 * Lecture du résultat d'exécution canonique d'une tâche. Réservé à un
 * utilisateur avec `cockpit.read` et dans sa portée opérationnelle.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tasks.execution",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const { id } = await ctx.params;
    const scope = await resolveOperationalScope(container, access.session);

    const task = await container.tasks.getByIdForScope(id, scope);
    if (!task) {
      return apiError("not_found", "tâche introuvable");
    }

    const record = await container.executionResults.getByTaskId(id);
    return json({ record });
  } catch (error) {
    return toErrorResponse(error);
  }
}
