import { resolveOperationalScope } from "@/server/administration/mission-scope";
import { appendSecurityAudit } from "@/server/auth/security-audit";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { readOmniRouteCockpit } from "@/server/omniroute/cockpit-service";
import { getTelemetryRateLimiter } from "@/server/telemetry/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "api.cockpit.omniroute";

/**
 * Façade OmniRoute stable et strictement en lecture seule. Elle réutilise la
 * session, le rôle, la portée, l'audit et le quota du cockpit. Tous les appels
 * OmniRoute sont effectués côté serveur ; aucun credential ni détail de modèle
 * n'est renvoyé au navigateur.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: ROUTE,
      role: "operator",
    });
    if (!access.ok) return access.response;

    const scope = await resolveOperationalScope(container, access.session);
    if (scope.kind !== "global") {
      await appendSecurityAudit(container.audit, {
        eventType: "auth.access.denied",
        userId: access.session.user.id,
        method: request.method,
        route: ROUTE,
        role: "operator",
        reason: "forbidden",
      }).catch(() => {});
      return apiError("forbidden", "Les indicateurs OmniRoute exigent la portée owner/admin.");
    }

    const decision = getTelemetryRateLimiter().check(access.session.user.id);
    if (!decision.allowed) {
      return apiError(
        "rate_limited",
        "Trop de lectures OmniRoute : réessayez plus tard.",
        undefined,
        { "retry-after": String(decision.retryAfterSeconds) },
      );
    }

    return json(await readOmniRouteCockpit(container));
  } catch (error) {
    return toErrorResponse(error);
  }
}
