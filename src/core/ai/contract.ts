import { z } from "zod";

import { sensitivityLevelSchema } from "@/core/contracts/tenant";

// ─────────────────────────────────────
// Routing intent
// ─────────────────────────────────────

/**
 * Intention métier abstraite — ICOS exprime ce qu'il veut,
 * pas quel provider utiliser.
 *
 * - `BEST_REASONING` — Raisonnement profond (Opus/Fable-level)
 * - `BEST_CODING` — Génération de code de haute qualité
 * - `FAST` — Réponse rapide, qualité moindre acceptable
 * - `CHEAP` — Coût minimal, qualité dégradée acceptable
 * - `PRIVATE` — Provider local/privé exigé (données sensibles)
 * - `FALLBACK` — Fallback explicite, dernier recours
 */
export const aiRoutingIntentSchema = z.enum([
  "BEST_REASONING",
  "BEST_CODING",
  "FAST",
  "CHEAP",
  "PRIVATE",
  "FALLBACK",
]);

export type AiRoutingIntent = z.infer<typeof aiRoutingIntentSchema>;

// ─────────────────────────────────────
// Error codes
// ─────────────────────────────────────

/**
 * Codes d'erreur normalisés — aucune erreur technique provider
 * ne filtre sans être mappée.
 */
export const aiErrorCodeSchema = z.enum([
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "TIMEOUT",
  "INVALID_RESPONSE",
  "POLICY_BLOCKED",
  "UNSUPPORTED_CAPABILITY",
  "CANCELLED",
  "INTERNAL_ERROR",
]);

export type AiErrorCode = z.infer<typeof aiErrorCodeSchema>;

// ─────────────────────────────────────
// Provider info
// ─────────────────────────────────────

export const aiProviderInfoSchema = z.object({
  /** Identifiant du provider (ex: "anthropic", "openai") */
  id: z.string().min(1),
  /** Nom du modèle (ex: "claude-sonnet-5", "gpt-4o") */
  model: z.string().min(1),
  /** Compte OmniRoute utilisé (optionnel) */
  account: z.string().optional(),
});

export type AiProviderInfo = z.infer<typeof aiProviderInfoSchema>;

// ─────────────────────────────────────
// Usage metadata
// ─────────────────────────────────────

export const aiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** Coût estimé en USD (peut ne pas être disponible). */
  costUsd: z.number().nonnegative().optional(),
});

export type AiUsage = z.infer<typeof aiUsageSchema>;

// ─────────────────────────────────────
// Generation result (discriminated union)
// ─────────────────────────────────────

/**
 * Résultat normalisé d'une génération AI.
 * INVARIANT : toute erreur non reconnue produit `INTERNAL_ERROR`
 * — fail-closed.
 */
export const aiGenerationResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    content: z.string(),
    finishReason: z.enum(["stop", "length", "content_filter"]),
    provider: aiProviderInfoSchema,
    usage: aiUsageSchema,
    latencyMs: z.number().int().nonnegative(),
    /** Explication textuelle du routage choisi par OmniRoute. */
    routeExplanation: z.string().optional(),
    fallbackUsed: z.boolean().default(false),
  }),
  z.object({
    success: z.literal(false),
    error: z.object({
      code: aiErrorCodeSchema,
      /** Message lisible, ne contient jamais de credential ou secret. */
      message: z.string().min(1),
      /** Vrai si un retry peut réussir (provider temporairement indisponible). */
      retryable: z.boolean(),
      /** Vrai si un fallback vers un autre provider est possible. */
      fallbackPossible: z.boolean(),
      /**
       * Message d'erreur normalisé provenant du provider.
       * NE JAMAIS LOGGER : peut contenir des données sensibles.
       * Utilisé uniquement pour le retour à l'appelant si nécessaire.
       */
      providerError: z.string().optional(),
    }),
    latencyMs: z.number().int().nonnegative(),
    provider: aiProviderInfoSchema.optional(),
    usage: aiUsageSchema.optional(),
    fallbackUsed: z.boolean().default(false),
    routeExplanation: z.string().optional(),
  }),
]);

export type AiGenerationResult = z.infer<typeof aiGenerationResultSchema>;

// ─────────────────────────────────────
// Routing request
// ─────────────────────────────────────

export const aiRoutingRequestSchema = z.object({
  /** Contenu du message utilisateur. */
  prompt: z.string().min(1),
  /** Instructions système (optionnel). */
  systemPrompt: z.string().optional(),

  // Intention métier
  intent: aiRoutingIntentSchema.default("BEST_REASONING"),

  // Contexte ICOS
  tenantId: z.string().min(1),
  /** Classification des données (C0–C3) pour routage compliant. */
  dataClassification: sensitivityLevelSchema.optional(),

  // Paramètres de génération
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),

  // Budget / qualité
  /** Coût maximum estimé en USD. */
  budgetMaxCostUsd: z.number().positive().optional(),
  qualityThreshold: z.enum(["draft", "standard", "high"]).default("standard"),

  // Contraintes de routage
  allowedProviderIds: z.array(z.string()).optional(),
  disallowedProviderIds: z.array(z.string()).optional(),
  /** Autorise le fallback vers un autre provider en cas d'échec. */
  fallbackAllowed: z.boolean().default(true),

  // Timeout
  /** Timeout en ms pour la requête HTTP. */
  timeoutMs: z.number().int().positive().default(60_000),

  // Corrélation
  /** Identifiant de corrélation traçable vers Mission/Run/Task. */
  correlationId: z.string().min(1),

  // Modalité
  modalite: z.enum(["chat"]).default("chat"),
});

export type AiRoutingRequest = z.infer<typeof aiRoutingRequestSchema>;

/**
 * AiRoutingRequest avec AbortSignal (non sérialisable).
 * L'AbortSignal est passé hors Zod lors de l'appel au port.
 */
export interface AiRoutingRequestWithSignal extends AiRoutingRequest {
  /** Signal d'annulation — coupe la requête HTTP en cours. */
  abortSignal?: AbortSignal;
}
