import type { AiGenerationResult, AiRoutingRequestWithSignal } from "@/core/ai";

/**
 * Port de génération AI — point d'accès unique pour appeler un modèle
 * via OmniRoute.
 *
 * INVARIANTS :
 * - N'envoie jamais de credentials/raw tokens dans le prompt
 * - N'enregistre jamais le contenu brut du prompt ou de la réponse dans les logs
 * - Timeout : la requête HTTP est annulée après `request.timeoutMs`
 * - Cancellation : si `request.abortSignal` est déclenché, la requête HTTP
 *   est annulée et le résultat retourne `CANCELLED`
 * - L'appelant reçoit un résultat normalisé, jamais une erreur HTTP brute
 */
export interface AiGatewayPort {
  generate(request: AiRoutingRequestWithSignal): Promise<AiGenerationResult>;
}

/**
 * Port de vérification de disponibilité d'OmniRoute.
 * N'appelle aucun provider — uniquement le healthcheck OmniRoute.
 */
export interface AiHealthPort {
  /** Retourne true si OmniRoute répond, false sinon. */
  check(): Promise<boolean>;
}
