import { getContainer } from "@/server/container";
import { apiError, json } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { BRAIN_IDS, BRAIN_ROLES } from "@/core/workforce/brains";
import { brainRoleStatuses } from "@/server/workforce/brain-role-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ÉTAT RÉEL DE LA DIGITAL WORKFORCE — LECTURE SEULE (décisions 0057, 0066, 0068, 0070).
 *
 * Remplace une requête `psql` manuelle par un mécanisme gouverné et tracé, construit
 * exclusivement sur `WorkforceReadModel.snapshot` (le magasin lui-même ne quitte jamais la
 * racine de composition — `WorkforceRuntime` n'expose pas `store`). Aucune écriture
 * possible depuis cette route.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.workforce.status",
      permission: "agents.manage",
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.workforce) {
      return apiError("persistence_unavailable", "digital workforce indisponible");
    }
    const principal = container.workforce.sessions.fromSession(access.session);
    const snapshot = await container.workforce.readModel.snapshot(principal);

    const brainAgents = snapshot.agents.filter((a) => BRAIN_IDS.includes(a.agentId));
    const brainRoles = brainRoleStatuses(snapshot);

    return json({
      generatedAt: snapshot.generatedAt,
      brains: {
        expected: BRAIN_IDS.length,
        registered: brainAgents.length,
        agents: brainAgents.map((a) => ({
          agentId: a.agentId,
          roleId: a.roleId,
          roleVersion: a.roleVersion,
          status: a.status,
          health: a.health,
          supervisorAgentId: a.supervisorAgentId,
          toolGrants: a.toolGrants.map((g) => g.toolId),
        })),
      },
      brainRoles: { expected: BRAIN_ROLES.length, roles: brainRoles },
      assignments: {
        total: snapshot.activeAssignments.length,
        forBrains: snapshot.activeAssignments.filter((a) => BRAIN_IDS.includes(a.assigneeAgentId))
          .length,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
