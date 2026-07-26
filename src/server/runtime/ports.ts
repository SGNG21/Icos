import type { ExecuteStepInput, ExecutionResult } from "@/core/runtime";

/**
 * Port d'exécution D4 — point d'entrée unique pour D2.
 *
 * D2 appelle `execute()` pour lancer l'exécution d'une étape de plan.
 * D4 orchestre la vérification de politique D1, l'isolation workspace,
 * la résolution de credentials, l'exécution via adaptateur, la collecte
 * d'artefacts et le nettoyage.
 *
 * INVARIANTS :
 * - La politique D1 est re-vérifiée au moment de l'exécution (pas de stale)
 * - Le workspace est isolé et nettoyé après exécution
 * - Les credentials ne sont jamais exposés dans les logs ou artefacts
 * - Le réseau est bloqué par défaut
 * - Le timeout tue l'arbre de processus complet
 * - L'annulation ne laisse pas de processus zombie
 */
export interface RuntimeExecutionPort {
  /**
   * @param signal Signal d'annulation externe (optionnel).
   * Si fourni et déclenché, l'exécution est annulée (état CANCELLED),
   * distinct du timeout interne (état TIMED_OUT).
   */
  execute(input: ExecuteStepInput, signal?: AbortSignal): Promise<ExecutionResult>;
}

// ─────────────────────────────────────
// Credential Broker
// ─────────────────────────────────────

/**
 * Référence à un credential — jamais le credential brut.
 * La substitution est effectuée par le runtime/gateway au point d'usage.
 */
export interface CredentialReference {
  /** Identifiant logique du credential (ex: "db-password"). */
  key: string;
  /**
   * Variable d'environnement dans laquelle le credential sera injecté
   * par le runtime (jamais exposée dans le process worker).
   */
  envVar: string;
  /** Description pour audit. */
  description: string;
}

/**
 * Résultat de résolution de credentials.
 */
export type CredentialResolution =
  | {
      available: true;
      /** Références aux credentials résolus. */
      references: CredentialReference[];
      /** Variables d'environnement scoped à injecter dans le worker. */
      environment: Record<string, string>;
    }
  | {
      available: false;
      /** Code d'erreur normalisé. */
      error: "BLOCKED_BY_CREDENTIAL_POLICY" | "CREDENTIAL_NOT_FOUND" | "INTERNAL_ERROR";
      message: string;
    };

/**
 * Requête de résolution de credentials.
 */
export interface CredentialRequest {
  tenantId: string;
  missionId: string;
  runId: string;
  /** Clés de credentials demandées (optionnel — résout tous les disponibles). */
  requiredKeys?: string[];
}

/**
 * Port de résolution de credentials.
 *
 * INVARIANT : ne retourne jamais de credential brut.
 * Seulement des références que le runtime peut substituer.
 */
export interface CredentialBrokerPort {
  resolve(request: CredentialRequest): Promise<CredentialResolution>;
}

// ─────────────────────────────────────
// Network Policy
// ─────────────────────────────────────

/**
 * Permissions réseau accordées à une exécution.
 */
export interface NetworkPermission {
  host: string;
  port?: number;
  protocol: "http" | "https" | "tcp";
}

/**
 * Décision de politique réseau.
 */
export type NetworkDecision =
  | {
      outcome: "allow";
      rules: NetworkPermission[];
      scope: "scoped" | "unrestricted";
    }
  | {
      outcome: "deny";
      reason: string;
    };

/**
 * Requête de politique réseau.
 */
export interface NetworkRequest {
  tenantId: string;
  missionId: string;
  runId: string;
  /** Points d'accès demandés (optionnel — évalue la politique par défaut). */
  requestedEndpoints?: Array<{
    host: string;
    port?: number;
    protocol: "http" | "https" | "tcp";
  }>;
}

/**
 * Port de politique réseau.
 *
 * INVARIANT : le défaut est DENY.
 * Aucun worker ne démarre avec un accès internet non restreint.
 */
export interface NetworkPolicyPort {
  check(request: NetworkRequest): Promise<NetworkDecision>;
}
