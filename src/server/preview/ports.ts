import type { PreviewResult } from "@/core/preview";

/**
 * Port de livraison de preview.
 *
 * V1 : LOCAL_DEV_ONLY — produit un résultat testable localement.
 * V2+ : support de preview Vercel derrière une policy explicite.
 *
 * INVARIANTS :
 * - Preview ≠ Production
 * - LOCAL_DEV_ONLY = true
 * - CLIENT_SYSTEM_ACCESS = false
 * - PRODUCTION_ACCESS = false
 * - CLIENT_CREDENTIALS = forbidden
 * - EXTERNAL_IRREVERSIBLE_ACTIONS = forbidden
 */
export interface PreviewDeliveryPort {
  /**
   * Prépare une preview locale du résultat d'intégration.
   * V1 : retourne le chemin local de la branche d'intégration.
   * V2+ : supporte le déploiement preview derrière une policy explicite.
   */
  deliver(integrationSha: string, integrationBranch: string): Promise<PreviewResult>;
}
