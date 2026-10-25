import { getContainer } from "@/server/container";
import { apiError, json } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { BRAIN_IDS } from "@/core/workforce/brains";
import { allBrainRolesActive, brainRoleStatuses } from "@/server/workforce/brain-role-view";
import { WorkforceConflictError, WorkforceDeniedError } from "@/server/workforce/workforce-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DERNIÈRE ÉTAPE — seed des 12 cerveaux + octroi des outils minimaux, via l'orchestration
 * canonique `WorkforceRuntime.bootstrap(admin, certifier)` (= `bootstrapWorkforce`, inchangée
 * : seedBootstrap → certify → activate → seedBrains → grantBrainTools, dans cet ordre, chaque
 * étage idempotent).
 *
 * APPELÉE ICI AVEC `certifier = admin = le principal de CETTE requête`. Ce n'est PAS une
 * auto-certification au sens gouverné : `certifyRole` refuse seulement si le certificateur
 * est le CRÉATEUR du rôle (`role.provenance.createdBy`, l'identité système `workforce-
 * bootstrap`), jamais s'il coïncide avec l'admin. Le flux à deux requêtes voulu pour la
 * certification (`/roles/[roleId]/certify` puis `/roles/[roleId]/activate`, potentiellement
 * sous deux sessions distinctes) doit avoir déjà fait passer les 9 rôles à `active` AVANT
 * d'appeler cette route : si c'est le cas, `bootstrap()` ignore silencieusement (et en toute
 * sécurité, par construction idempotente) ses propres étapes de certification/activation
 * pour ces rôles et ne fait que semer les cerveaux et accorder les outils. Si un rôle n'est
 * PAS encore actif, cette route tentera de le certifier ET de l'activer avec le MÊME
 * principal — ce qui fonctionne pour un opérateur unique, mais ne constitue alors pas une
 * revue indépendante : utiliser les deux routes séparées quand une seconde personne est
 * disponible.
 *
 * Idempotente : ne réécrit aucun cerveau déjà présent, ne retire ni n'élargit un outil déjà
 * accordé.
 *
 * GARDE-FOU AJOUTÉ (ne pas retirer) : `bootstrapWorkforce` lui-même, pour un rôle encore
 * `draft`, appelle `certifyRole(certifier, roleId, version, requiredRoleTests(role, skills))`
 * — c'est-à-dire qu'il réutilise la liste des tests EXIGÉS comme liste des tests RÉUSSIS,
 * sans aucune preuve humaine réelle. Appeler `bootstrap()` sur un rôle non encore actif
 * reviendrait donc à fabriquer une certification, exactement ce qui est interdit. Cette
 * route REFUSE donc d'appeler `bootstrap()` si un seul des 9 rôles n'est pas déjà `active` —
 * passer par `/roles/[roleId]/certify` (avec une vraie attestation) est alors obligatoire.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.workforce.brains.activate",
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
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";

    if (dryRun) {
      const snapshot = await container.workforce.readModel.snapshot(principal);
      const roles = brainRoleStatuses(snapshot);
      const brains = BRAIN_IDS.map((agentId) => ({
        agentId,
        alreadyPresent: snapshot.agents.some((a) => a.agentId === agentId),
      }));
      return json({
        dryRun: true,
        limitedPreview: true,
        roles,
        rolesAllActive: allBrainRolesActive(roles),
        brains,
        note:
          "aperçu limité : précondition des rôles et présence des cerveaux uniquement ; " +
          "ne rejoue pas evaluateAgentCreation. L'appel réel reste la seule preuve complète.",
      });
    }

    const snapshot = await container.workforce.readModel.snapshot(principal);
    const roles = brainRoleStatuses(snapshot);
    if (!allBrainRolesActive(roles)) {
      const notYetActive = roles.filter((r) => r.status !== "active");
      return apiError(
        "governance_denied",
        "des rôles de cerveaux ne sont pas encore actifs ; cette route refuse de les " +
          "certifier automatiquement (voir garde-fou dans le commentaire du fichier) — " +
          "utiliser /api/admin/workforce/roles/[roleId]/certify puis /activate pour chacun",
        { notYetActive: notYetActive.map((r) => `${r.roleId}@${r.version}`) },
      );
    }

    const report = await container.workforce.bootstrap(principal, principal);
    return json({ dryRun: false, calledBy: principal.id, report });
  } catch (error) {
    if (error instanceof WorkforceDeniedError) {
      return apiError("governance_denied", "activation refusée par la gouvernance", {
        violations: error.violations,
      });
    }
    if (error instanceof WorkforceConflictError) {
      return apiError(
        "transient_conflict",
        "conflit temporaire lors de l'activation des cerveaux, veuillez réessayer",
        undefined,
        { "retry-after": "1" },
      );
    }
    return toErrorResponse(error);
  }
}
