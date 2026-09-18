import { getContainer } from "@/server/container";
import { buildCockpitProjection } from "@/features/cockpit/projection";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";

/**
 * Projection Cockpit — READ-ONLY.
 *
 * Agrège l'état canonique ICOS (tasks, agents, résultats d'exécution, actions
 * en attente) pour une consommation directe par l'interface. Cette projection
 * est DÉRIVÉE : elle ne porte aucune règle métier propre, n'écrit rien et ne
 * doit jamais devenir un second moteur métier.
 *
 * La portée opérationnelle de l'utilisateur est appliquée (`listForScope`) :
 * la projection ne révèle jamais plus que ce que l'utilisateur peut lire.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.cockpit",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const scope = container.operationalAccess
      ? await container.operationalAccess.resolveScope(access.session)
      : { kind: "global" as const };

    const [agents, tasks, pendingActions] = await Promise.all([
      container.agents.listForScope(scope),
      container.tasks.listForScope(scope),
      container.actions.listForScope(scope, { approvalStatus: "pending" }),
    ]);

    const executions = await container.executionResults.listByTaskIds(tasks.map((t) => t.id));
    const projection = buildCockpitProjection({ tasks, agents, executions });

    return json({
      counts: projection.counts,
      activeWork: projection.activeWork,
      attentionRequired: projection.attentionRequired,
      recentResults: projection.recentResults,
      pendingApprovals: pendingActions.length,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
