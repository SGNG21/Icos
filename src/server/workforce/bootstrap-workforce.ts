import { BRAIN_IDS, BRAIN_ROLES } from "@/core/workforce/brains";
import { loadWorkforceBootstrap } from "@/core/workforce/bootstrap";
import { requiredRoleTests } from "@/core/workforce/role-composer";
import type { Principal } from "@/core/workforce/governance";

import { seedBrains, type BrainSeedReport } from "./brain-seed";
import { grantBrainTools, type BrainGrantReport } from "./brain-tool-grants";
import type { WorkforceStore } from "./ports";
import type { WorkforceService } from "./workforce-service";

/**
 * L'AMORÇAGE CANONIQUE DE LA WORKFORCE — IDEMPOTENT, ET UN ACTE HUMAIN (verrou C6).
 *
 * Quatre étapes, dans le seul ordre où elles peuvent réussir, et chacune par l'autorité qui
 * lui appartient déjà. Ce fichier n'en crée AUCUNE : il ordonne.
 *
 *   1. SEED des skills, rôles et départements (`seedBootstrap`).
 *   2. CERTIFICATION des neuf rôles des cerveaux, par un humain INDÉPENDANT du créateur,
 *      avec les tests que chaque rôle exige (`requiredRoleTests`). Ce n'est pas une
 *      formalité : un rôle non certifié ne s'active pas, et un cerveau ne peut pas exister
 *      sur un rôle inactif.
 *   3. SEED des douze cerveaux (`seedBrains`).
 *   4. OCTROI des outils minimaux (`grantBrainTools`), sans quoi la gouvernance refuse
 *      chaque affectation en `MISSION_TOOL_GRANT` et les douze lignes ne portent rien.
 *
 * ── POURQUOI DEUX HUMAINS ───────────────────────────────────────────────────────────────
 * `certifyRole` REFUSE un certificateur qui est le créateur du rôle : une compétence qu'on
 * s'accorde à soi-même n'est pas une certification. L'amorçage exige donc deux principals
 * humains distincts, et c'est volontairement un frottement — pas un paramètre à contourner.
 *
 * ── POURQUOI PAS AU DÉMARRAGE DU RUNTIME ────────────────────────────────────────────────
 * Rien ici ne doit s'exécuter tout seul au boot. Créer douze identités durables et leur
 * accorder des outils est un acte d'administration ; le faire au démarrage voudrait dire
 * qu'un redéploiement accorde des pouvoirs. Le propriétaire le lance, comme
 * `auth:bootstrap`.
 *
 * ── IDEMPOTENT À CHAQUE ÉTAGE ───────────────────────────────────────────────────────────
 * Re-lancer est sans effet : un rôle déjà actif n'est pas recertifié, un cerveau déjà
 * présent n'est pas réécrit, un outil déjà détenu n'est pas réaccordé. Un état PARTIEL
 * (redémarrage au milieu) est repris là où il s'était arrêté.
 */

export interface WorkforceBootstrapReport {
  readonly rolesActivated: readonly string[];
  readonly rolesAlreadyActive: readonly string[];
  readonly brains: BrainSeedReport;
  readonly grants: BrainGrantReport;
  /** Vrai seulement si les douze cerveaux existent ET portent leurs outils. */
  readonly complete: boolean;
}

export interface WorkforceBootstrapDeps {
  readonly service: Pick<
    WorkforceService,
    "seedBootstrap" | "certifyRole" | "activateRole" | "createAgent" | "changePolicy"
  >;
  readonly store: Pick<WorkforceStore, "getAgent" | "getRole" | "listAgents">;
  readonly now?: () => string;
}

export async function bootstrapWorkforce(
  deps: WorkforceBootstrapDeps,
  /** Crée, active, accorde. C'est son identité que portent les grants. */
  admin: Principal,
  /** Certifie. DOIT être une autre personne que `admin` : la gouvernance le vérifie. */
  certifier: Principal,
): Promise<WorkforceBootstrapReport> {
  const bootstrap = loadWorkforceBootstrap();
  await deps.service.seedBootstrap(admin, bootstrap);

  const rolesActivated: string[] = [];
  const rolesAlreadyActive: string[] = [];
  for (const { roleId, version } of BRAIN_ROLES) {
    const existing = await deps.store.getRole(admin.tenantId, roleId, version);
    if (existing?.status === "active") {
      rolesAlreadyActive.push(roleId);
      continue;
    }
    const definition = bootstrap.roles.find((r) => r.roleId === roleId && r.version === version);
    if (!definition) throw new Error(`WORKFORCE_BOOTSTRAP_ROLE_MISSING:${roleId}@${version}`);
    /* Un rôle déjà certifié mais non activé ne se recertifie pas : on l'active, c'est tout. */
    if (existing?.status !== "certified") {
      await deps.service.certifyRole(
        certifier,
        roleId,
        version,
        requiredRoleTests(definition, bootstrap.skills),
      );
    }
    await deps.service.activateRole(admin, roleId, version);
    rolesActivated.push(roleId);
  }

  const brains = await seedBrains(
    { service: deps.service, store: deps.store, ...(deps.now ? { now: deps.now } : {}) },
    admin,
  );
  const grants = await grantBrainTools(
    { service: deps.service, store: deps.store, ...(deps.now ? { now: deps.now } : {}) },
    admin,
    BRAIN_IDS,
  );

  return {
    rolesActivated,
    rolesAlreadyActive,
    brains,
    grants,
    complete: brains.complete && grants.complete,
  };
}
