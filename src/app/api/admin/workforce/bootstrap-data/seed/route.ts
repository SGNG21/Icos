import { getContainer } from "@/server/container";
import { apiError, json } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { loadWorkforceBootstrap } from "@/core/workforce/bootstrap";
import { WorkforceConflictError } from "@/server/workforce/workforce-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ÉTAPE 0 DE L'ACTIVATION — charge les skills/rôles/départements `draft` (décision 0057).
 *
 * Précondition de `certify`/`activate` : un rôle ne peut être lu puis certifié que s'il
 * existe déjà dans le magasin. Idempotent par construction (`WorkforceService.seedBootstrap`
 * n'insère que ce qui manque) : rejouable sans effet sur un état déjà chargé. N'active, ne
 * certifie et ne crée aucun agent — uniquement les définitions `draft`.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.workforce.bootstrap-data.seed",
      permission: "agents.manage",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.workforce) {
      return apiError("persistence_unavailable", "digital workforce indisponible");
    }
    const principal = container.workforce.sessions.fromSession(access.session);

    const before = await container.workforce.readModel.snapshot(principal);
    await container.workforce.service.seedBootstrap(principal, loadWorkforceBootstrap());
    const after = await container.workforce.readModel.snapshot(principal);

    return json({
      rolesBefore: before.roles.length,
      rolesAfter: after.roles.length,
      inserted: after.roles.length - before.roles.length,
    });
  } catch (error) {
    // `seedBootstrap` n'écrit qu'en « insert si absent », sans comparer-et-échanger : sous
    // PostgreSQL le verrou advisory par tenant (`PostgresWorkforceStore.transaction`) sérialise
    // déjà tout appel concurrent, donc ce chemin ne devrait jamais être pris aujourd'hui. Le
    // traiter quand même, comme les 3 autres routes d'écriture, évite qu'un futur changement
    // de `seedBootstrap` vers une écriture CAS régresse silencieusement vers un 500 générique
    // ici alors que les autres routes renvoient 503 + Retry-After — cohérence du traitement des
    // conflits sur l'ensemble des routes d'écriture, pas seulement sur trois d'entre elles.
    if (error instanceof WorkforceConflictError) {
      return apiError(
        "transient_conflict",
        "conflit temporaire lors du chargement, veuillez réessayer",
        undefined,
        { "retry-after": "1" },
      );
    }
    return toErrorResponse(error);
  }
}
