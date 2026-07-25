import type { RuntimeAdapterInput, RuntimeAdapterResult } from "@/core/runtime";

/**
 * Interface d'adaptateur d'exécution D4.
 *
 * Chaque adaptateur implémente une méthode d'exécution différente :
 * - LocalRuntimeAdapter : exécution locale (V1)
 * - RemoteRuntimeAdapter : exécution distante (futur)
 * - DockerRuntimeAdapter : conteneur Docker (futur)
 * - etc.
 *
 * L'adaptateur reçoit un workspace déjà créé et isolé.
 * Il ne gère pas la politique, les credentials ou le réseau —
 * c'est la responsabilité de l'ExecutionOrchestrator.
 */
export interface AgentRuntimeAdapter {
  /** Nom lisible de l'adaptateur. */
  readonly name: string;

  /**
   * Exécute une étape dans le workspace fourni.
   *
   * @param input - Contexte d'exécution (workspace, timeout, step info)
   * @param abortSignal - Signal d'annulation (optionnel)
   * @returns Résultat de l'adaptateur
   */
  execute(
    input: RuntimeAdapterInput,
    abortSignal?: AbortSignal,
  ): Promise<RuntimeAdapterResult>;
}
