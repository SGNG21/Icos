import { readLiveOverview } from "@/features/cockpit/live-sources";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vue live des cinq sources (CORE3, workers, OmniRoute, PostgreSQL/mémoire, VPS),
 * READ-ONLY, avec fraîcheur par source (`Observed<T>`).
 *
 * Authentifiée (`cockpit.read`), scopée : les sources tenant-wide répondent
 * `forbidden` hors portée owner/admin, jamais une valeur vide. Aucune donnée
 * n'est fabriquée ; aucune écriture ; aucun appel de modèle.
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
    return json(await readLiveOverview(container, access.session));
  } catch (error) {
    return toErrorResponse(error);
  }
}
