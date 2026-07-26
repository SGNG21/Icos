import type { IntegrationSpec, IntegrationResult, GateResult } from "@/core/integration";

/**
 * Port des gates globales.
 * Exécute les vérifications qualité sur une branche d'intégration.
 */
export interface GlobalGatesPort {
  /** Exécute toutes les gates (lint, typecheck, test, build, git diff --check). */
  executeAll(workspacePath: string): Promise<GateResult[]>;

  /** Exécute une gate spécifique. */
  executeGate(gate: string, workspacePath: string): Promise<GateResult>;

  /** Vérifie git diff --check (trailing whitespace, merge conflicts). */
  gitDiffCheck(workspacePath: string): Promise<GateResult>;
}

/**
 * Port de l'orchestrateur d'intégration.
 */
export interface IntegrationOrchestratorPort {
  /**
   * Exécute l'intégration complète.
   * 1. Ordonne les commits (topologique)
   * 2. Crée une branche d'intégration
   * 3. Applique les commits dans l'ordre
   * 4. Détecte les conflits
   * 5. Exécute les gates globales
   * 6. Produit le résultat
   */
  integrate(spec: IntegrationSpec): Promise<IntegrationResult>;
}
