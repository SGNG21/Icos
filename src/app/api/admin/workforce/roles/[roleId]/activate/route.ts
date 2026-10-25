import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { activateRoleBodySchema } from "@/server/http/administration-schemas";
import {
  WorkforceConflictError,
  WorkforceDeniedError,
  WorkforceNotFoundError,
} from "@/server/workforce/workforce-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ACTIVATION D'UN RÔLE CERTIFIÉ — SECONDE REQUÊTE, SOUS UNE SESSION INDÉPENDANTE DE LA
 * CERTIFICATION (ou la même, si un seul opérateur humain est disponible aujourd'hui ; rien
 * ici ne force artificiellement une différence d'identité au-delà de ce que `certifyRole`
 * impose déjà via `SELF_CERTIFICATION`).
 *
 * Le PRINCIPAL de cette requête devient l'administrateur qui active. `activateRole` refuse
 * `NOT_CERTIFIED` si l'étape précédente n'a pas réussi, et `ACTOR_NOT_AUTHORIZED` si ce
 * principal n'a pas `agents.manage`.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ roleId: string }> },
): Promise<Response> {
  // Déclarés hors du `try` pour rester lisibles dans le `catch` : construire le message
  // `not_found` contrôlé ci-dessous a besoin de `roleId`/`version` sans jamais retomber sur
  // `error.message` (forme interne non contractuelle de l'exception).
  let roleId: string | undefined;
  let version: string | undefined;
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.workforce.roles.activate",
      permission: "agents.manage",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.workforce) {
      return apiError("persistence_unavailable", "digital workforce indisponible");
    }

    ({ roleId } = await ctx.params);
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }
    const parsed = activateRoleBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "corps d'activation invalide", zodDetails(parsed.error));
    }
    version = parsed.data.version;

    const principal = container.workforce.sessions.fromSession(access.session);

    if (dryRun) {
      const snapshot = await container.workforce.readModel.snapshot(principal);
      const role = snapshot.roles.find((r) => r.roleId === roleId && r.version === version);
      if (!role) {
        // Même forme structurée que le chemin réel (catch ci-dessous) — revue indépendante
        // n°2, finding informationnel : avant ce commit les deux renvoyaient déjà les mêmes
        // valeurs en texte, mais sous une forme différente (`details` absent ici).
        return apiError("not_found", `rôle ${roleId}@${version} introuvable`, { roleId, version });
      }
      return json({
        dryRun: true,
        limitedPreview: true,
        roleStatus: role.status,
        likelyOutcome: role.status === "certified" ? "would-activate" : "would-refuse",
        ...(role.status !== "certified" ? { likelyViolation: "NOT_CERTIFIED" } : {}),
        note: "aperçu limité au statut du rôle ; ACTOR_NOT_AUTHORIZED n'est vérifié que par l'appel réel.",
      });
    }

    const role = await container.workforce.service.activateRole(principal, roleId, version);
    return json({ dryRun: false, role, activatedBy: principal.id });
  } catch (error) {
    if (error instanceof WorkforceNotFoundError) {
      // Message CONTRÔLÉ par la route (comme le chemin dryRun ci-dessus), jamais
      // `error.message` tel quel — voir le même commentaire dans certify/route.ts.
      return apiError("not_found", `rôle ${roleId ?? "?"}@${version ?? "?"} introuvable`, {
        roleId: roleId ?? null,
        version: version ?? null,
      });
    }
    if (error instanceof WorkforceDeniedError) {
      return apiError("governance_denied", "activation refusée par la gouvernance", {
        violations: error.violations,
      });
    }
    if (error instanceof WorkforceConflictError) {
      return apiError(
        "transient_conflict",
        "conflit temporaire lors de l'activation, veuillez réessayer",
        undefined,
        { "retry-after": "1" },
      );
    }
    return toErrorResponse(error);
  }
}
