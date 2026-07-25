import type { TenantContext, TenantId, TenantResolution } from "@/core/contracts/tenant";

/**
 * Port de résolution du tenant courant.
 *
 * L'implémentation actuelle est mono-tenant (SingleTenantResolver).
 * L'interface reste stable pour le futur multi-tenant : on ajoutera
 * simplement une table user → tenant au moment de la résolution.
 */
export interface TenantResolutionPort {
  /**
   * Résout le TenantContext pour une requête / session donnée.
   *
   * En mode mono-tenant actuel, le tenant est dérivé de la session
   * utilisateur authentifiée. Pour les opérations système/migration,
   * le mode d'exécution explicite est requis.
   *
   * FAIL_CLOSED : pas de session → pas de tenant → échec.
   */
  resolve(context: TenantResolutionRequest): Promise<TenantResolution>;

  /**
   * Vérifie que la ressource appartient bien au tenant courant.
   * Utilisé par les repositories tenant-scoped.
   */
  ownsResource(tenantId: TenantId, resourceOwnerId: string): boolean;
}

export interface TenantResolutionRequest {
  /** Session utilisateur authentifiée (optionnelle pour les modes spéciaux) */
  session?: { userId: string };
  /** Headers de la requête HTTP (pour résolution future depuis header) */
  headers?: Headers;
  /** Mode d'exécution spécial */
  executionMode?: "normal" | "system" | "migration" | "test";
}
