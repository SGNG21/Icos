import type { AiGenerationResult, AiRoutingRequestWithSignal, AiRoutingRequest } from "@/core/ai";
import { aiRoutingRequestSchema } from "@/core/ai";
import type { AiGatewayPort, AiHealthPort } from "./ports";
import type { OmniRouteConfig } from "./omniroute-config";

// ─────────────────────────────────────
// Types internes (mapping OmniRoute)
// ─────────────────────────────────────

interface OmniRouteChatRequest {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  /** OmniRoute : fournisseurs autorisés. */
  allowed_providers?: string[];
  /** OmniRoute : fournisseurs interdits. */
  disallowed_providers?: string[];
  /** OmniRoute : fallback autorisé. */
  allow_fallback: boolean;
  /** OmniRoute : intention de routage. */
  routing_intent?: string;
  /** OmniRoute : coût max estimé. */
  max_cost_usd?: number;
}

interface OmniRouteChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

interface OmniRouteChatResponse {
  id?: string;
  model: string;
  provider?: string;
  choices: OmniRouteChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost?: number;
  routing_explanation?: string;
  fallback_used?: boolean;
}

interface OmniRouteErrorResponse {
  error: {
    message: string;
    type?: string;
    code?: string;
    provider_error?: string;
  };
}

// ─────────────────────────────────────
// Adapter-specific error (to distinguish from generic errors)
// ─────────────────────────────────────

class InvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResponseError";
  }
}

// ─────────────────────────────────────
// Observability hooks
// ─────────────────────────────────────

export interface AiGatewayObservabilityHooks {
  /** Appelée avant l'envoi de la requête HTTP. */
  onRequestStarted?: (correlationId: string, intent: string) => void;
  /** Appelée après réception de la réponse HTTP. */
  onRequestCompleted?: (
    correlationId: string,
    result: {
      success: boolean;
      latencyMs: number;
      providerId?: string;
      modelId?: string;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      errorCode?: string;
    },
  ) => void;
}

// ─────────────────────────────────────
// Adapter
// ─────────────────────────────────────

/**
 * Adapter ICOS → OmniRoute.
 *
 * Traduit une `AiRoutingRequest` en appel HTTP vers OmniRoute,
 * et normalise la réponse en `AiGenerationResult`.
 *
 * INVARIANTS :
 * - Aucun credential provider ne transite par l'adapter
 * - Aucun prompt/response brut n'est journalisé
 * - Aucun retry — OmniRoute gère ses propres retries
 * - Fail-closed : toute exception inattendue → INTERNAL_ERROR
 */
export class OmniRouteAdapter implements AiGatewayPort, AiHealthPort {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly hooks: AiGatewayObservabilityHooks | undefined;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    config: OmniRouteConfig,
    hooks?: AiGatewayObservabilityHooks,
    /** Fonction fetch injectable (tests, environnement non-standard). */
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultTimeoutMs = config.defaultTimeoutMs;
    this.maxTimeoutMs = config.maxTimeoutMs;
    this.hooks = hooks;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  // ─────────────────────────────────────
  // AiGatewayPort
  // ─────────────────────────────────────

  async generate(request: AiRoutingRequestWithSignal): Promise<AiGenerationResult> {
    const startTime = Date.now();

    // Extraire le signal d'annulation (non sérialisable)
    const { abortSignal, ...requestFields } = request;

    // Valider et normaliser la requête via Zod (applique les defaults)
    const parsed = aiRoutingRequestSchema.parse(requestFields);

    // Appliquer les contraintes de sécurité
    const timeoutMs = Math.min(parsed.timeoutMs, this.maxTimeoutMs);

    // Utiliser parsed pour tout ce qui est Zod, request.abortSignal pour le signal
    const req = { ...parsed, abortSignal };

    // Vérifier le signal d'annulation avant d'appeler fetch
    if (req.abortSignal?.aborted === true) {
      return this.makeError(
        "CANCELLED",
        "Requête annulée avant envoi",
        false,
        false,
        Date.now() - startTime,
        req.correlationId,
      );
    }

    this.hooks?.onRequestStarted?.(req.correlationId, req.intent);

    try {
      const body = this.buildRequestBody(req);
      const httpHeaders = this.buildHeaders(req);
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: httpHeaders,
          body: JSON.stringify(body),
          signal: req.abortSignal,
        },
        timeoutMs,
        req.correlationId,
      );

      const latencyMs = Date.now() - startTime;

      // HTTP error → map to AiError
      if (!response.ok) {
        const errBody = await this.tryParseError(response);
        const result = this.mapHttpError(errBody, response.status, latencyMs, req.correlationId);
        this.hooks?.onRequestCompleted?.(req.correlationId, {
          success: false,
          latencyMs: result.latencyMs,
          errorCode: !result.success ? result.error.code : undefined,
        });
        return result;
      }

      // Parse body
      const data = await this.parseJsonResponse(response);

      const result = this.mapSuccessResponse(data, latencyMs, req.correlationId);
      this.hooks?.onRequestCompleted?.(req.correlationId, {
        success: true,
        latencyMs: result.latencyMs,
        providerId: result.success ? result.provider.id : undefined,
        modelId: result.success ? result.provider.model : undefined,
        inputTokens: result.success ? result.usage.inputTokens : undefined,
        outputTokens: result.success ? result.usage.outputTokens : undefined,
        costUsd: result.success ? result.usage.costUsd : undefined,
      });
      return result;
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      // L'AbortSignal a été déclenché
      if (error instanceof DOMException && error.name === "AbortError") {
        const errResult = this.makeError(
          "CANCELLED",
          "Requête annulée",
          false,
          false,
          latencyMs,
          req.correlationId,
        );
        this.hooks?.onRequestCompleted?.(req.correlationId, {
          success: false,
          latencyMs,
          errorCode: "CANCELLED",
        });
        return errResult;
      }

      // Timeout (AbortSignal.timeout)
      if (error instanceof DOMException && error.name === "TimeoutError") {
        const errResult = this.makeError(
          "TIMEOUT",
          "Délai d'attente dépassé",
          true,
          true,
          latencyMs,
          req.correlationId,
        );
        this.hooks?.onRequestCompleted?.(req.correlationId, {
          success: false,
          latencyMs,
          errorCode: "TIMEOUT",
        });
        return errResult;
      }

      // TypeError = réseau (fetch a échoué)
      if (error instanceof TypeError) {
        const errResult = this.makeError(
          "PROVIDER_UNAVAILABLE",
          "Impossible de joindre le service de génération",
          true,
          true,
          latencyMs,
          req.correlationId,
        );
        this.hooks?.onRequestCompleted?.(req.correlationId, {
          success: false,
          latencyMs,
          errorCode: "PROVIDER_UNAVAILABLE",
        });
        return errResult;
      }

      // Réponse invalide (JSON malformé, contenu manquant)
      if (error instanceof InvalidResponseError) {
        const errResult = this.makeError(
          "INVALID_RESPONSE",
          error.message,
          false,
          true,
          latencyMs,
          req.correlationId,
        );
        this.hooks?.onRequestCompleted?.(req.correlationId, {
          success: false,
          latencyMs,
          errorCode: "INVALID_RESPONSE",
        });
        return errResult;
      }

      // Erreur inconnue → fail-closed
      const message = error instanceof Error ? error.message : "Erreur interne inconnue";
      const errResult = this.makeError(
        "INTERNAL_ERROR",
        message,
        false,
        false,
        latencyMs,
        req.correlationId,
      );
      this.hooks?.onRequestCompleted?.(req.correlationId, {
        success: false,
        latencyMs,
        errorCode: "INTERNAL_ERROR",
      });
      return errResult;
    }
  }

  // ─────────────────────────────────────
  // AiHealthPort
  // ─────────────────────────────────────

  async check(): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────
  // Private: request building
  // ─────────────────────────────────────

  private buildRequestBody(request: AiRoutingRequest): OmniRouteChatRequest {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }

    messages.push({ role: "user", content: request.prompt });

    return {
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      allowed_providers: request.allowedProviderIds,
      disallowed_providers: request.disallowedProviderIds,
      allow_fallback: request.fallbackAllowed,
      routing_intent: request.intent,
      max_cost_usd: request.budgetMaxCostUsd,
    };
  }

  private buildHeaders(request: AiRoutingRequest): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Correlation-Id": request.correlationId,
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    // Tenant & compliance
    headers["X-Tenant-Id"] = request.tenantId;
    if (request.dataClassification) {
      headers["X-Data-Classification"] = request.dataClassification;
    }

    return headers;
  }

  // ─────────────────────────────────────
  // Private: fetch with combined timeout + abort
  // ─────────────────────────────────────

  private async fetchWithTimeout(
    url: string,
    init: RequestInit & { signal?: AbortSignal },
    timeoutMs: number,
    _correlationId: string,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = init.signal
      ? this.combineAbortSignals(init.signal, timeoutSignal)
      : timeoutSignal;

    return this.fetchFn(url, { ...init, signal: combinedSignal });
  }

  private combineAbortSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
    // Si l'un des deux est déjà déclenché, retourner ce signal
    if (s1.aborted) return s1;
    if (s2.aborted) return s2;

    // Utiliser AbortSignal.any si disponible, sinon créer un controller manuel
    if (typeof AbortSignal.any === "function") {
      return AbortSignal.any([s1, s2]);
    }

    // Fallback manuel pour les environnements sans AbortSignal.any
    const controller = new AbortController();
    const abort = () => controller.abort();
    s1.addEventListener("abort", abort, { once: true });
    s2.addEventListener("abort", abort, { once: true });
    return controller.signal;
  }

  // ─────────────────────────────────────
  // Private: response parsing
  // ─────────────────────────────────────

  private async parseJsonResponse(response: Response): Promise<OmniRouteChatResponse> {
    const text = await response.text();
    try {
      return JSON.parse(text) as OmniRouteChatResponse;
    } catch {
      throw new InvalidResponseError("Réponse JSON invalide du fournisseur");
    }
  }

  private async tryParseError(response: Response): Promise<OmniRouteErrorResponse | undefined> {
    try {
      const text = await response.text();
      return JSON.parse(text) as OmniRouteErrorResponse;
    } catch {
      return undefined;
    }
  }

  // ─────────────────────────────────────
  // Private: response mapping
  // ─────────────────────────────────────

  private mapSuccessResponse(
    data: OmniRouteChatResponse,
    latencyMs: number,
    _correlationId: string,
  ): AiGenerationResult {
    // Vérifier la structure minimale
    if (!data.choices?.[0]?.message?.content) {
      return this.makeError(
        "INVALID_RESPONSE",
        "Réponse invalide du fournisseur : contenu manquant",
        false,
        true,
        latencyMs,
        _correlationId,
      );
    }

    const choice = data.choices[0];

    // Mapper finish_reason
    const finishReason = this.mapFinishReason(choice.finish_reason);

    const result: AiGenerationResult = {
      success: true,
      content: choice.message.content,
      finishReason,
      provider: {
        id: data.provider ?? "unknown",
        model: data.model,
      },
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
        costUsd: data.cost,
      },
      latencyMs,
      routeExplanation: data.routing_explanation,
      fallbackUsed: data.fallback_used ?? false,
    };

    return result;
  }

  private mapFinishReason(reason: string): "stop" | "length" | "content_filter" {
    switch (reason) {
      case "stop":
        return "stop";
      case "length":
        return "length";
      default:
        // content_filter, null, ou autre → content_filter
        return "content_filter";
    }
  }

  private mapHttpError(
    parsed: OmniRouteErrorResponse | undefined,
    status: number,
    latencyMs: number,
    correlationId: string,
  ): AiGenerationResult {
    switch (status) {
      case 429:
        return this.makeError(
          "RATE_LIMITED",
          parsed?.error?.message ?? "Limite de taux atteinte",
          true,
          true,
          latencyMs,
          correlationId,
        );
      case 403:
        return this.makeError(
          "POLICY_BLOCKED",
          parsed?.error?.message ?? "Requête bloquée par la politique",
          false,
          false,
          latencyMs,
          correlationId,
        );
      case 400:
        return this.makeError(
          "UNSUPPORTED_CAPABILITY",
          parsed?.error?.message ?? "Capacité non supportée",
          false,
          true,
          latencyMs,
          correlationId,
        );
      default:
        return this.makeError(
          status >= 500 ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR",
          parsed?.error?.message ?? `Erreur HTTP ${status}`,
          status >= 500,
          status >= 500,
          latencyMs,
          correlationId,
        );
    }
  }

  // ─────────────────────────────────────
  // Private: error builder
  // ─────────────────────────────────────

  private makeError(
    code: string,
    message: string,
    retryable: boolean,
    fallbackPossible: boolean,
    latencyMs: number,
    _correlationId: string,
    providerError?: string,
  ): AiGenerationResult {
    return {
      success: false,
      error: {
        code,
        message,
        retryable,
        fallbackPossible,
        // providerError n'est jamais loggé — voir spec
        providerError: providerError,
      },
      latencyMs,
      fallbackUsed: false,
    } as AiGenerationResult;
  }
}
