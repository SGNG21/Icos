import type { TenantContext, TenantId, TenantResolution } from "@/core/contracts/tenant";
import type { TenantResolutionPort, TenantResolutionRequest } from "./ports";

/**
 * Résolveur mono-tenant pour COMPLIANCE-1.
 *
 * Tous les utilisateurs authentifiés appartiennent au même tenant unique.
 * Le tenantId est résolu depuis la session auth, pas depuis une input client.
 *
 * Migration depuis CURRENT_SINGLE_TENANT_ID :
 * - Les constantes globales sont remplacées par ce résolveur
 * - Le TenantId canonique reste "default" pour la compatibilité avec les
 *   données C2 existantes (skills → tenantId = "default")
 * - Mais le *chemin de résolution* est désormais explicite et gouverné
 * - Aucune route tenant-scoped n'importe plus CURRENT_SINGLE_TENANT_ID
 */
export class SingleTenantResolver implements TenantResolutionPort {
  private readonly TENANT_ID: TenantId = "default" as TenantId;

  async resolve(request: TenantResolutionRequest): Promise<TenantResolution> {
    // Modes spéciaux (système, migration, test) — pas de session requise.
    if (
      request.executionMode === "system" ||
      request.executionMode === "migration" ||
      request.executionMode === "test"
    ) {
      return {
        ok: true,
        context: {
          tenantId: this.TENANT_ID,
          resolvedAt: new Date().toISOString(),
          resolvedBy: request.executionMode,
        },
      };
    }

    // Mode normal : une session est requise.
    if (!request.session) {
      return { ok: false, reason: "no_tenant" };
    }

    // Mono-tenant : tout utilisateur authentifié est résolu vers le tenant unique.
    // En multi-tenant futur, cette résolution irait chercher le tenantId
    // dans le profil utilisateur (table user → tenant).
    return {
      ok: true,
      context: {
        tenantId: this.TENANT_ID,
        resolvedAt: new Date().toISOString(),
        resolvedBy: "auth",
      },
    };
  }

  ownsResource(tenantId: TenantId, resourceOwnerId: string): boolean {
    return tenantId === resourceOwnerId;
  }
}
