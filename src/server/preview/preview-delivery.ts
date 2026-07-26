import type { PreviewResult } from "@/core/preview";
import type { PreviewDeliveryPort } from "./ports";

/**
 * PreviewDelivery — V1 : local only.
 *
 * Produit un résultat testable localement sans déploiement externe.
 * Si un déploiement externe est demandé sans autorisation, retourne
 * WAITING_FOR_HUMAN.
 *
 * CONFIGURATION V1 :
 * - LOCAL_DEV_ONLY = true
 * - CLIENT_SYSTEM_ACCESS = false
 * - PRODUCTION_ACCESS = false
 * - CLIENT_CREDENTIALS = forbidden
 * - EXTERNAL_IRREVERSIBLE_ACTIONS = forbidden
 */
export class PreviewDelivery implements PreviewDeliveryPort {
  constructor(
    private readonly config: PreviewConfig = {},
  ) {}

  async deliver(integrationSha: string, integrationBranch: string): Promise<PreviewResult> {
    const start = Date.now();

    // V1 : toujours local
    if (!this.config.allowExternalPreview) {
      return {
        status: "LOCAL_RESULT_READY",
        integrationSha,
        integrationBranch,
        summary: `Résultat d'intégration disponible localement sur la branche "${integrationBranch}" (SHA: ${integrationSha.slice(0, 12)}). ` +
          "Le déploiement preview externe nécessite une autorisation explicite.",
        durationMs: Date.now() - start,
        completedAt: new Date().toISOString(),
      };
    }

    // External preview non implémenté en V1
    return {
      status: "WAITING_FOR_HUMAN",
      integrationSha,
      integrationBranch,
      summary: "Le déploiement preview externe nécessite une approbation humaine.",
      humanGateReason: "EXTERNAL_PREVIEW_REQUIRES_APPROVAL",
      durationMs: Date.now() - start,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Configuration du preview delivery.
 */
export interface PreviewConfig {
  /** Si true, autorise le déploiement preview externe (défaut: false). */
  allowExternalPreview?: boolean;
}
