import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";
import { aiRoutingIntentSchema } from "@/core/ai";
import type { SystemAgent } from "@/core/policy";

// ─────────────────────────────────────
// Worker status
// ─────────────────────────────────────

/**
 * États d'un worker.
 *
 * Machine d'état :
 * CREATED ──→ RUNNING ──→ SUCCEEDED
 *               │            │
 *               ├──→ FAILED  │
 *               ├──→ TIMED_OUT
 *               └──→ CANCELLED
 *
 * INVARIANT : les états terminaux sont immutables.
 */
export const workerStatusSchema = z.enum([
  "CREATED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "LOST",
]);

export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const TERMINAL_WORKER_STATUSES: readonly WorkerStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "LOST",
];

// ─────────────────────────────────────
// WorkerSpec
// ─────────────────────────────────────

/**
 * Spécification complète d'un worker.
 * Contient tout le contexte nécessaire pour exécuter une tâche isolée.
 */
export const workerSpecSchema = z.object({
  /** ID de la tâche dans le DAG Supervisor. */
  taskId: idSchema,
  /** Mission propriétaire (D2). */
  missionId: z.string().min(1),
  /** Tenant propriétaire. */
  tenantId: z.string().min(1),

  /** Objectif de la tâche (quoi faire). */
  objective: z.string().min(1),
  /** Critères d'acceptation. */
  acceptanceCriteria: z.array(z.string()).default([]),

  /** Profil de modèle AI (BEST_CODING, etc.). */
  modelProfile: aiRoutingIntentSchema.default("BEST_CODING"),

  /** Skills requises. */
  skillRequirements: z.array(z.string()).default([]),
  /** Outils nécessaires. */
  toolRequirements: z.array(z.string()).default([]),

  /** Périmètre de permission pour la vérification D1. */
  permissionEnvelope: z.object({
    action: z.string().min(1),
    resource: z.string().min(1),
    capabilityKey: z.string().optional(),
  }),

  /** Timeout en ms. */
  timeoutMs: z.number().int().positive().default(300_000),

  /** Budget. */
  budget: z
    .object({
      maxTokens: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
    })
    .default({}),

  /** Politique de revue. */
  reviewPolicy: z
    .object({
      requiresReview: z.boolean().default(true),
      reviewerCount: z.number().int().nonnegative().default(1),
    })
    .default({ requiresReview: true, reviewerCount: 1 }),
});

export type WorkerSpec = z.infer<typeof workerSpecSchema>;

// ─────────────────────────────────────
// WorkerResult
// ─────────────────────────────────────

/**
 * Résultat structuré d'un worker.
 */
export const workerResultSchema = z.object({
  /** Issue du worker. */
  outcome: z.enum(["SUCCESS", "FAILED", "BLOCKED", "NEEDS_REVIEW", "NEEDS_HUMAN"]),
  /** Commit SHA si la tâche a produit un commit. */
  commitSha: z.string().optional(),
  /** Artefacts collectés. */
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        mimeType: z.string().optional(),
        size: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
  /** Message ou résumé. */
  summary: z.string().default(""),
  /** Code d'erreur (si FAILED). */
  errorCode: z.string().optional(),
  /** Message d'erreur (jamais de credentials). */
  errorMessage: z.string().optional(),
  /** Bloqueur identifié (si BLOCKED). */
  blockedBy: z.string().optional(),
  /** Question humaine (si NEEDS_HUMAN). */
  question: z.string().optional(),
  /** Durée d'exécution en ms. */
  durationMs: z.number().int().nonnegative().default(0),
});

export type WorkerResult = z.infer<typeof workerResultSchema>;

// ─────────────────────────────────────
// Worker — état complet
// ─────────────────────────────────────

export const workerSchema = z.object({
  /** Identifiant unique du worker. */
  id: idSchema,
  /** Spécification du worker. */
  spec: workerSpecSchema,
  /** État courant. */
  status: workerStatusSchema.default("CREATED"),
  /** Résultat (présent si terminal). */
  result: workerResultSchema.optional(),
  /** Chemin du workspace assigné. */
  workspacePath: z.string().optional(),
  /** Chemin du worktree git assigné. */
  worktreePath: z.string().optional(),

  // Horodatages
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  updatedAt: isoDateTimeSchema,
});

export type Worker = z.infer<typeof workerSchema>;

// ─────────────────────────────────────
// Inputs
// ─────────────────────────────────────

export interface CreateWorkerInput {
  taskId: string;
  missionId: string;
  tenantId: string;
  objective: string;
  acceptanceCriteria?: string[];
  modelProfile?: "BEST_REASONING" | "BEST_CODING" | "FAST" | "CHEAP" | "PRIVATE" | "FALLBACK";
  skillRequirements?: string[];
  toolRequirements?: string[];
  permissionEnvelope: {
    action: string;
    resource: string;
    capabilityKey?: string;
  };
  /**
   * Identité système porteuse de permissions pour l'appel D1.
   * Créée au bootstrap (composition root), jamais auto-attribuée.
   * Non définie = le PermissionGate refuse par défaut (default-deny).
   * Propagée dans PolicyRequest.actor avec kind: "system".
   *
   * @see SystemAgent
   */
  agentIdentity?: SystemAgent;
  timeoutMs?: number;
  budget?: {
    maxTokens?: number;
    maxCostUsd?: number;
  };
  requiresReview?: boolean;
  /**
   * Chemin du worktree Git isolé où le worker doit opérer.
   * Présent quand le Supervisor a créé un worktree pour cette tâche.
   * Le worker écrit ses changements dans ce répertoire pour que
   * WorktreeManager.captureResult() puisse les capturer.
   */
  worktreePath?: string;
}
