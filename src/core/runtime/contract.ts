import { z } from "zod";

import type { AiUsage } from "@/core/ai";
import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

// ─────────────────────────────────────
// Execution Status — D4 State Machine
// ─────────────────────────────────────

/**
 * États d'exécution D4.
 *
 * Machine d'état :
 * STARTING ──→ RUNNING ──→ SUCCEEDED
 *    │             ├──→ FAILED
 *    │             ├──→ CANCELLED
 *    │             ├──→ TIMED_OUT
 *    │             └──→ LOST
 *    ├──→ FAILED
 *    └──→ CANCELLED
 *
 * INVARIANT : les états terminaux sont immutables.
 */
export const executionStatusSchema = z.enum([
  "STARTING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "LOST",
]);

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

/** États terminaux : aucune transition sortante autorisée. */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "LOST",
];

// ─────────────────────────────────────
// Execution Error Codes
// ─────────────────────────────────────

/**
 * Codes d'erreur normalisés D4.
 * - Codes D4-natifs pour les erreurs d'exécution
 * - Codes D3-mappés pour les erreurs AI (préfixés AI_)
 *
 * INVARIANT : toute erreur non reconnue produit `INTERNAL_ERROR` (fail-closed).
 */
export const executionErrorCodeSchema = z.enum([
  // D4-native errors
  "POLICY_DENIED",
  "REQUIRES_APPROVAL",
  "CREDENTIAL_UNAVAILABLE",
  "NETWORK_BLOCKED",
  "WORKSPACE_ERROR",
  "WORKSPACE_ESCAPE_DENIED",
  "PROCESS_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "WORKER_LOST",
  "CLEANUP_ERROR",
  "INTERNAL_ERROR",
  // D3-mapped errors
  "AI_PROVIDER_UNAVAILABLE",
  "AI_RATE_LIMITED",
  "AI_TIMEOUT",
  "AI_INVALID_RESPONSE",
  "AI_POLICY_BLOCKED",
  "AI_UNSUPPORTED_CAPABILITY",
  "AI_INTERNAL_ERROR",
]);

export type ExecutionErrorCode = z.infer<typeof executionErrorCodeSchema>;

// ─────────────────────────────────────
// Artifact
// ─────────────────────────────────────

export const artifactItemSchema = z.object({
  /** Nom logique de l'artefact (ex: "stdout", "report.json"). */
  name: z.string().min(1),
  /** Type MIME si connu. */
  mimeType: z.string().optional(),
  /** Chemin relatif dans le workspace. */
  path: z.string().min(1),
  /** Taille en bytes (0 si vide). */
  size: z.number().int().nonnegative().default(0),
  /** Contenu textuel (tronqué si trop volumineux). */
  content: z.string().optional(),
});

export type ArtifactItem = z.infer<typeof artifactItemSchema>;

// ─────────────────────────────────────
// Usage Metadata (subset enrichi de AiUsage)
// ─────────────────────────────────────

export const usageMetadataSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  providerId: z.string(),
  model: z.string(),
  latencyMs: z.number().int().nonnegative(),
  fallbackUsed: z.boolean().default(false),
});

export type UsageMetadata = z.infer<typeof usageMetadataSchema>;

// ─────────────────────────────────────
// Execution Error
// ─────────────────────────────────────

export const executionErrorSchema = z.object({
  code: executionErrorCodeSchema,
  /** Message lisible, ne contient jamais de credential ou secret. */
  message: z.string().min(1),
  /** Vrai si un retry peut réussir. */
  retryable: z.boolean().default(false),
  /** Détails supplémentaires (optionnel, utilisation débug uniquement). */
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ExecutionError = z.infer<typeof executionErrorSchema>;

// ─────────────────────────────────────
// Execution Result (discriminated union)
// ─────────────────────────────────────

export const executionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    state: z.literal("SUCCEEDED"),
    /** Résultat produit par l'exécution. */
    output: z.unknown(),
    /** Artefacts collectés dans le workspace. */
    artifacts: z.array(artifactItemSchema).default([]),
    /** Métadonnées d'utilisation AI (si applicable). */
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative().optional(),
        providerId: z.string(),
        model: z.string(),
        latencyMs: z.number().int().nonnegative(),
        fallbackUsed: z.boolean().default(false),
      })
      .optional(),
    /** Durée totale de l'exécution en ms. */
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    state: z.enum(["FAILED", "CANCELLED", "TIMED_OUT", "LOST"]),
    error: executionErrorSchema,
    /** Durée totale avant l'échec en ms. */
    latencyMs: z.number().int().nonnegative().default(0),
    /** Artefacts collectés avant l'échec. */
    artifacts: z.array(artifactItemSchema).default([]),
  }),
]);

export type ExecutionResult = z.infer<typeof executionResultSchema>;

// ─────────────────────────────────────
// Execute Step Input (D2 → D4)
// ─────────────────────────────────────

export const executeStepInputSchema = z.object({
  /** Identifiant de la mission propriétaire. */
  missionId: z.string().min(1),
  /** Tenant propriétaire. */
  tenantId: z.string().min(1),
  /** Identifiant du run D2. */
  runId: z.string().min(1),
  /** Index de l'étape dans le plan. */
  stepIndex: z.number().int().nonnegative(),
  /** Description de l'étape. */
  stepDescription: z.string().min(1),
  /** Clé de compétence associée (optionnelle). */
  skillKey: z.string().optional(),
  /** Référence d'outil (optionnelle). */
  toolRef: z.string().optional(),
  /** Identifiant de l'agent exécutant (optionnel). */
  agentId: z.string().optional(),
  /** Identifiant de corrélation traçable. */
  correlationId: z.string().min(1),
  /** Timeout en ms pour l'exécution. */
  timeoutMs: z.number().int().positive().default(60_000),
  /** L'étape a-t-elle un effet externe ? */
  hasExternalEffect: z.boolean().default(false),
});

export type ExecuteStepInput = z.infer<typeof executeStepInputSchema>;

// ─────────────────────────────────────
// Runtime Execution State (internal D4)
// ─────────────────────────────────────

/**
 * État interne d'une exécution D4.
 * Ne pas exposer à D2 — c'est l'état de runtime, pas de mission.
 */
export const runtimeStateSchema = z.object({
  runId: z.string().min(1),
  missionId: z.string().min(1),
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  status: executionStatusSchema,
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  error: executionErrorSchema.optional(),
  /** Chemin du workspace alloué. */
  workspacePath: z.string().optional(),
});

export type RuntimeState = z.infer<typeof runtimeStateSchema>;

// ─────────────────────────────────────
// Adapter Input (D4 orchestrator → adapter)
// ─────────────────────────────────────

export const runtimeAdapterInputSchema = z.object({
  runId: z.string().min(1),
  missionId: z.string().min(1),
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  stepDescription: z.string().min(1),
  skillKey: z.string().optional(),
  toolRef: z.string().optional(),
  agentId: z.string().optional(),
  /** Chemin absolu du workspace isolé. */
  workspacePath: z.string().min(1),
  /** Timeout en ms. */
  timeoutMs: z.number().int().positive(),
  /**
   * Commande à exécuter (optionnel).
   * Si absent, l'adaptateur V1 retourne un succès sans spawn
   * pour la compatibilité avec les tests orchestrateur existants.
   * Doit être un exécutable, pas une chaîne shell.
   */
  command: z.string().min(1).optional(),
  /** Arguments séparés de la commande. Jamais concaténés dans une chaîne shell. */
  args: z.array(z.string()).optional(),
  /**
   * Variables d'environnement supplémentaires à injecter
   * (ex: credentials résolus par CredentialBrokerPort).
   * Surcharge les variables de l'allowlist.
   */
  env: z.record(z.string(), z.string()).optional(),
});

export type RuntimeAdapterInput = z.infer<typeof runtimeAdapterInputSchema>;

// ─────────────────────────────────────
// Adapter Result (adapter → D4 orchestrator)
// ─────────────────────────────────────

const adapterSuccessSchema = z.object({
  ok: z.literal(true),
  /** Contenu produit par l'adaptateur. */
  output: z.unknown(),
});

const adapterErrorSchema = z.object({
  ok: z.literal(false),
  /** Code d'erreur de l'adaptateur. */
  errorCode: executionErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean().optional().default(false),
});

export const runtimeAdapterResultSchema = z.discriminatedUnion("ok", [
  adapterSuccessSchema,
  adapterErrorSchema,
]);

export type RuntimeAdapterResult = z.infer<typeof runtimeAdapterResultSchema>;

export type RuntimeAdapterSuccess = z.infer<typeof adapterSuccessSchema>;
export type RuntimeAdapterError = z.infer<typeof adapterErrorSchema>;
