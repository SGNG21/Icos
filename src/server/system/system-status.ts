import type { Env } from "@/config/env";

/**
 * État de santé des dépendances ICOS, dérivé de la configuration RÉELLE.
 *
 * Principes :
 * - aucun statut codé en dur : tout provient de l'environnement résolu et de la
 *   composition effective du container ;
 * - distinction ESSENTIEL / OPTIONNEL : une intégration optionnelle non
 *   configurée n'est PAS une dégradation et ne doit pas produire d'alerte
 *   globale ;
 * - seul un composant essentiel indisponible dégrade l'état général.
 */
export type IntegrationState = "connected" | "available" | "not_configured" | "unavailable";

export interface IntegrationStatus {
  key: string;
  label: string;
  state: IntegrationState;
  /** Essentiel : son indisponibilité empêche ICOS de fonctionner. */
  essential: boolean;
}

export interface SystemStatus {
  /** `operational` si tous les composants essentiels répondent. */
  overall: "operational" | "degraded";
  essential: IntegrationStatus[];
  optional: IntegrationStatus[];
}

export interface SystemStatusInput {
  env: Pick<
    Env,
    "PERSISTENCE" | "DATABASE_URL" | "GITHUB_TOKEN" | "N8N_BASE_URL" | "DOLIBARR_BASE_URL"
  >;
  /** Vrai si le container a réellement composé une persistance PostgreSQL. */
  persistenceReady: boolean;
  /** Vrai si un dispatcher d'exécution durable est composé (Temporal). */
  executionReady: boolean;
  /** Vrai si le retour Temporal → ICOS est configuré (secret présent). */
  executionCallbackReady: boolean;
}

/**
 * Calcule l'état système à partir de faits observables. Ne réalise AUCUN appel
 * réseau : le Cockpit doit rendre instantanément et sans effet de bord.
 */
export function resolveSystemStatus(input: SystemStatusInput): SystemStatus {
  const essential: IntegrationStatus[] = [
    {
      key: "postgres",
      label: "PostgreSQL",
      state: input.persistenceReady ? "connected" : "unavailable",
      essential: true,
    },
    {
      key: "temporal",
      label: "Temporal",
      state: input.executionReady ? "connected" : "unavailable",
      essential: true,
    },
    {
      key: "execution_callback",
      label: "Retour d’exécution",
      state: input.executionCallbackReady ? "connected" : "unavailable",
      essential: true,
    },
  ];

  const optional: IntegrationStatus[] = [
    {
      key: "github",
      label: "GitHub",
      state: input.env.GITHUB_TOKEN ? "available" : "not_configured",
      essential: false,
    },
    {
      key: "n8n",
      label: "n8n",
      state: input.env.N8N_BASE_URL ? "available" : "not_configured",
      essential: false,
    },
    {
      key: "dolibarr",
      label: "Dolibarr",
      state: input.env.DOLIBARR_BASE_URL ? "available" : "not_configured",
      essential: false,
    },
  ];

  const overall = essential.every((item) => item.state === "connected")
    ? "operational"
    : "degraded";

  return { overall, essential, optional };
}
