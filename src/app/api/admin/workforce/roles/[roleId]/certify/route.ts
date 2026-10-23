import { getContainer } from "@/server/container";
import { apiError, json, readJson } from "@/server/http/respond";
import { protectRoute } from "@/server/http/protect-route";
import { toErrorResponse } from "@/server/http/map-error";
import { zodDetails } from "@/server/http/errors";
import { certifyRoleBodySchema } from "@/server/http/administration-schemas";
import {
  WorkforceConflictError,
  WorkforceDeniedError,
  WorkforceNotFoundError,
} from "@/server/workforce/workforce-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CERTIFICATION D'UN RÔLE DE CERVEAU — PREMIÈRE DES DEUX REQUÊTES INDÉPENDANTES (ADR 0068,
 * esprit d'ADR 0044 : pas de revue pré-approuvée).
 *
 * Le PRINCIPAL de CETTE requête (sa propre session authentifiée) devient le certificateur.
 * `testsPassed` et `evidenceRef` sont son attestation — jamais calculés ni vérifiés ici :
 * c'est un acte humain qui lit le dossier de préparation (Phase 1), pas une automatisation.
 * `certifyRole` (gouvernance pure, `role-composer.ts`) refuse toujours : l'auto-certification
 * (le certificateur ne peut pas être le créateur du rôle), un principal non humain si le rôle
 * porte un risque HIGH/CRITICAL, et toute preuve manquante (`MISSING_TESTS`).
 *
 * `evidenceRef` N'EST PAS écrit dans l'événement `role.certified` (qui ne connaît que
 * `{version, testsPassed}` — modifier cette forme toucherait `WorkforceService`, hors
 * périmètre). Il est (1) renvoyé dans la réponse HTTP pour que l'appelant l'archive lui-même,
 * et (2) journalisé en une ligne structurée (voir plus bas) — captée par `journalctl` en
 * production, à l'image de `COMPUTE_BOOTSTRAP`. Ce n'est PAS la même garantie de durabilité
 * que l'écriture append-only de `workforce_events` ; ne pas le présenter comme tel.
 *
 * `?dryRun=true` : aperçu LIMITÉ au statut du rôle, lu via `WorkforceReadModel.snapshot` (le
 * magasin ne quitte jamais la racine de composition — impossible de relire ici `provenance`
 * ou les tests exigés par chaque compétence). Ne vérifie donc NI l'auto-certification NI la
 * preuve de tests : seul l'appel réel (`dryRun` absent) les valide, via `certifyRole` tel
 * quel. Ce n'est pas une imprécision cachée — elle est explicite dans la réponse.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ roleId: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.admin.workforce.roles.certify",
      permission: "agents.manage",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    if (!container.workforce) {
      return apiError("persistence_unavailable", "digital workforce indisponible");
    }

    const { roleId } = await ctx.params;
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }
    const parsed = certifyRoleBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "corps de certification invalide", zodDetails(parsed.error));
    }
    const { version, testsPassed, evidenceRef } = parsed.data;

    const principal = container.workforce.sessions.fromSession(access.session);

    if (dryRun) {
      const snapshot = await container.workforce.readModel.snapshot(principal);
      const role = snapshot.roles.find((r) => r.roleId === roleId && r.version === version);
      if (!role) {
        return apiError("not_found", `rôle ${roleId}@${version} introuvable`);
      }
      return json({
        dryRun: true,
        limitedPreview: true,
        roleStatus: role.status,
        likelyOutcome: role.status === "draft" ? "would-attempt-certification" : "would-refuse",
        ...(role.status !== "draft" ? { likelyViolation: "NOT_DRAFT" } : {}),
        note:
          "aperçu limité au statut du rôle ; SELF_CERTIFICATION et MISSING_TESTS ne sont " +
          "vérifiés que par l'appel réel (dryRun absent).",
        testsPassed,
        evidenceRef,
      });
    }

    const role = await container.workforce.service.certifyRole(
      principal,
      roleId,
      version,
      testsPassed,
    );
    // Trace structurée, non garantie append-only (voir commentaire d'en-tête) : capturée par
    // journalctl en production, sans toucher la forme de `role.certified`.
    console.log(
      JSON.stringify({
        event: "ROLE_CERTIFICATION_EVIDENCE",
        roleId,
        version,
        certifiedBy: principal.id,
        evidenceRef,
        testsPassed,
      }),
    );
    return json({ dryRun: false, role, certifiedBy: principal.id, evidenceRef });
  } catch (error) {
    if (error instanceof WorkforceNotFoundError) {
      return apiError("not_found", error.message);
    }
    if (error instanceof WorkforceDeniedError) {
      return apiError("governance_denied", "certification refusée par la gouvernance", {
        violations: error.violations,
      });
    }
    if (error instanceof WorkforceConflictError) {
      return apiError(
        "transient_conflict",
        "conflit temporaire lors de la certification, veuillez réessayer",
        undefined,
        { "retry-after": "1" },
      );
    }
    return toErrorResponse(error);
  }
}
