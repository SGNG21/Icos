import type { AiGenerationResult, AiRoutingRequestWithSignal } from "@/core/ai";
import type { AiGatewayPort, AiHealthPort } from "./ports";

/**
 * Fake AiGatewayPort pour les tests des consommateurs (D4).
 *
 * Comportement par défaut :
 * - `generate()` retourne toujours un succès avec un message fixe
 * - `check()` retourne toujours true
 *
 * Peut être configuré pour tester des cas d'erreur :
 * ```ts
 * const fake = new FakeAiGateway();
 * fake.nextResult = { success: false, error: { code: "RATE_LIMITED", ... } };
 * ```
 */
export class FakeAiGateway implements AiGatewayPort, AiHealthPort {
  /** Prochain résultat à retourner — undefined = utilise le défaut. */
  nextResult: AiGenerationResult | undefined;

  /** Résultats des appels précédents (pour assertions). */
  readonly calls: AiRoutingRequestWithSignal[] = [];

  async generate(request: AiRoutingRequestWithSignal): Promise<AiGenerationResult> {
    this.calls.push(request);

    if (this.nextResult !== undefined) {
      return this.nextResult;
    }

    // Résultat par défaut
    return {
      success: true,
      content: `Réponse simulée pour : ${request.prompt}`,
      finishReason: "stop",
      provider: {
        id: "fake-provider",
        model: "fake-model",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        costUsd: 0.001,
      },
      latencyMs: 100,
      routeExplanation: "Route simulée via FakeAiGateway",
      fallbackUsed: false,
    };
  }

  async check(): Promise<boolean> {
    return true;
  }

  /** Réinitialise l'état du fake. */
  reset(): void {
    this.nextResult = undefined;
    this.calls.length = 0;
  }
}
