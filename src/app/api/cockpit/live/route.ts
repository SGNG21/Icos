import { readLiveOverview } from "@/features/cockpit/live-sources";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { getLiveRateLimiter } from "@/server/telemetry/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vue live des cinq sources (CORE3, workers, OmniRoute, PostgreSQL/mémoire, VPS),
 * READ-ONLY, avec fraîcheur par source (`Observed<T>`).
 *
 * Authentifiée (`cockpit.read`), scopée : les sources tenant-wide répondent
 * `forbidden` hors portée owner/admin, jamais une valeur vide. Limitée à 60
 * lectures/min/utilisateur (429 + Retry-After) ; les agrégats durables sont servis
 * depuis un cache de 10 s. Aucune donnée n'est fabriquée ; aucune écriture ;
 * aucun appel de modèle.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.cockpit.live",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }
    const decision = getLiveRateLimiter().check(access.session.user.id);
    if (!decision.allowed) {
      return apiError(
        "rate_limited",
        "Trop de lectures de la vue live : réessayez plus tard.",
        undefined,
        {
          "retry-after": String(decision.retryAfterSeconds),
        },
      );
    }
    return json(await readLiveOverview(container, access.session));
  } catch (error) {
    return toErrorResponse(error);
  }
}
