import type { AiGenerationResult, AiRoutingRequestWithSignal } from "@/core/ai";
import type { AiGatewayPort } from "@/server/ai/ports";

import type {
  CredentialBrokerPort,
  CredentialRequest,
  CredentialResolution,
  NetworkDecision,
  NetworkPolicyPort,
  NetworkRequest,
} from "./ports";

// ─────────────────────────────────────
// Fake Credential Broker
// ─────────────────────────────────────

/**
 * Fake CredentialBrokerPort pour les tests.
 *
 * Comportement par défaut : aucun credential disponible.
 * Peut être configuré pour retourner des credentials de test
 * ou simuler des erreurs.
 */
export class FakeCredentialBroker implements CredentialBrokerPort {
  /** Résolution personnalisée — undefined = comportement par défaut. */
  nextResolution: CredentialResolution | undefined;

  /** Credentials prédéfinis à retourner. */
  predefinedCredentials: Record<string, string> = {};

  /** Historique des appels pour assertions. */
  readonly calls: CredentialRequest[] = [];

  async resolve(request: CredentialRequest): Promise<CredentialResolution> {
    this.calls.push(request);

    if (this.nextResolution !== undefined) {
      return this.nextResolution;
    }

    // Comportement par défaut : pas de credentials V1
    const references = Object.entries(this.predefinedCredentials).map(([key, value]) => ({
      key,
      envVar: `CRED_${key.toUpperCase().replace(/[^a-zA-Z0-9]/g, "_")}`,
      description: `Credential: ${key}`,
      // Note: la valeur réelle n'est pas exposée via les références
    }));

    return {
      available: true,
      references,
      environment: this.predefinedCredentials,
    };
  }

  /** Réinitialise l'état du fake. */
  reset(): void {
    this.nextResolution = undefined;
    this.predefinedCredentials = {};
    this.calls.length = 0;
  }
}

// ─────────────────────────────────────
// Fake Network Policy
// ─────────────────────────────────────

/**
 * Fake NetworkPolicyPort pour les tests.
 *
 * Comportement par défaut : DENY (conforme à la politique de sécurité).
 * Peut être configuré pour ALLOW dans des tests spécifiques.
 */
export class FakeNetworkPolicy implements NetworkPolicyPort {
  /** Décision personnalisée — undefined = DENY par défaut. */
  nextDecision: NetworkDecision | undefined;

  /** Historique des appels pour assertions. */
  readonly calls: NetworkRequest[] = [];

  async check(request: NetworkRequest): Promise<NetworkDecision> {
    this.calls.push(request);
    return (
      this.nextDecision ?? {
        outcome: "deny",
        reason: "D4 V1: réseau non configuré pour l'accès worker",
      }
    );
  }

  /** Configure la politique pour autoriser. */
  allowAll(): void {
    this.nextDecision = {
      outcome: "allow",
      rules: [{ host: "*", protocol: "https" }],
      scope: "unrestricted",
    };
  }

  /** Réinitialise l'état du fake. */
  reset(): void {
    this.nextDecision = undefined;
    this.calls.length = 0;
  }
}

// ─────────────────────────────────────
// Fake Runtime Execution Port
// ─────────────────────────────────────

/**
 * Fake RuntimeExecutionPort pour les tests D2.
 *
 * Comportement par défaut : retourne un succès avec un message fixe.
 * Peut être configuré pour tester des cas d'erreur.
 */
export class FakeRuntimeExecutionPort {
  /** Prochain résultat — undefined = succès par défaut. */
  nextResult:
    | {
        ok: true;
        state: string;
        output: unknown;
        artifacts?: Array<{ name: string; path: string; size: number }>;
        latencyMs?: number;
      }
    | {
        ok: false;
        state: "FAILED" | "CANCELLED" | "TIMED_OUT" | "LOST";
        error: { code: string; message: string };
      }
    | undefined;

  /** Historique des appels. */
  readonly calls: Array<{ missionId: string; runId: string; stepIndex: number }> = [];

  async execute(input: {
    missionId: string;
    tenantId: string;
    runId: string;
    stepIndex: number;
    correlationId: string;
  }): Promise<{
    ok: boolean;
    state: string;
    output?: unknown;
    artifacts?: Array<{ name: string; path: string; size: number }>;
    error?: { code: string; message: string };
    latencyMs?: number;
  }> {
    this.calls.push({
      missionId: input.missionId,
      runId: input.runId,
      stepIndex: input.stepIndex,
    });

    if (this.nextResult) {
      return this.nextResult;
    }

    return {
      ok: true,
      state: "SUCCEEDED",
      output: `Exécution simulée pour étape ${input.stepIndex}`,
      artifacts: [],
      latencyMs: 50,
    };
  }

  /** Réinitialise l'état du fake. */
  reset(): void {
    this.nextResult = undefined;
    this.calls.length = 0;
  }
}
