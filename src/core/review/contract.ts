import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

// ─────────────────────────────────────
// Review verdicts
// ─────────────────────────────────────

export const reviewVerdictSchema = z.enum(["PASS", "CHANGES_REQUIRED", "FAILED"]);

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

// ─────────────────────────────────────
// Review check categories
// ─────────────────────────────────────

export const reviewCategorySchema = z.enum([
  "acceptance_criteria",
  "tests",
  "scope",
  "regressions",
  "security_boundaries",
  "architecture_boundaries",
  "code_quality",
  "documentation",
]);

export type ReviewCategory = z.infer<typeof reviewCategorySchema>;

// ─────────────────────────────────────
// Review check item
// ─────────────────────────────────────

export const reviewCheckSchema = z.object({
  category: reviewCategorySchema,
  description: z.string().min(1),
  passed: z.boolean(),
  details: z.string().optional(),
});

export type ReviewCheck = z.infer<typeof reviewCheckSchema>;

// ─────────────────────────────────────
// ReviewSpec — ce que le reviewer doit inspecter
// ─────────────────────────────────────

export const reviewSpecSchema = z.object({
  /** ID de la tâche à reviewer. */
  taskId: idSchema,
  /** Mission propriétaire. */
  missionId: z.string().min(1),
  /** Tenant propriétaire. */
  tenantId: z.string().min(1),
  /** Objectif de la tâche (critères d'acceptation). */
  objective: z.string().min(1),
  /** Critères d'acceptation spécifiques. */
  acceptanceCriteria: z.array(z.string()).default([]),
  /** Catégories de vérification requises. */
  requiredChecks: z
    .array(reviewCategorySchema)
    .default([
      "acceptance_criteria",
      "tests",
      "scope",
      "security_boundaries",
      "architecture_boundaries",
    ]),
  /** Chemin du worktree contenant le travail à reviewer. */
  worktreePath: z.string().min(1),
  /** SHA du commit à reviewer. */
  commitSha: z.string().optional(),
});

export type ReviewSpec = z.infer<typeof reviewSpecSchema>;

// ─────────────────────────────────────
// ReviewResult
// ─────────────────────────────────────

export const reviewResultSchema = z.object({
  /** Verdict global. */
  verdict: reviewVerdictSchema,
  /** Checks individuels. */
  checks: z.array(reviewCheckSchema).default([]),
  /** Résumé de la revue. */
  summary: z.string().min(1),
  /** Commentaires détaillés. */
  comments: z.string().optional(),
  /** Niveau de confiance (1-5). */
  confidence: z.number().int().min(1).max(5).default(3),
  /** Durée de la revue en ms. */
  durationMs: z.number().int().nonnegative().default(0),
  /** ID du reviewer worker. */
  reviewerWorkerId: z.string().optional(),
  /** Horodatage. */
  completedAt: isoDateTimeSchema,
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;

// ─────────────────────────────────────
// CorrectionSpec
// ─────────────────────────────────────

export const correctionSpecSchema = z.object({
  /** ID de la tâche originale à corriger. */
  originalTaskId: idSchema,
  /** Mission propriétaire. */
  missionId: z.string().min(1),
  /** ID de la revue qui a demandé la correction. */
  reviewId: z.string().min(1),
  /** Verdict de la revue (toujours CHANGES_REQUIRED ou FAILED). */
  reviewVerdict: z.enum(["CHANGES_REQUIRED", "FAILED"]),
  /** Commentaires de la revue à adresser. */
  reviewComments: z.string().min(1),
  /** Checks échoués à corriger. */
  failedChecks: z.array(reviewCheckSchema).default([]),
  /** Numéro de tentative de correction. */
  attemptNumber: z.number().int().positive(),
  /** Nombre maximum de tentatives. */
  maxAttempts: z.number().int().positive().default(3),
  /** Chemin du worktree contenant le code à corriger. */
  worktreePath: z.string().min(1),
});

export type CorrectionSpec = z.infer<typeof correctionSpecSchema>;

// ─────────────────────────────────────
// CorrectionResult
// ─────────────────────────────────────

export const correctionResultSchema = z.object({
  /** Issue de la correction. */
  outcome: z.enum(["CORRECTED", "FAILED", "ESCALATED"]),
  /** Résumé des corrections appliquées. */
  summary: z.string().min(1),
  /** SHA du commit de correction. */
  commitSha: z.string().optional(),
  /** Message d'erreur si FAILED. */
  errorMessage: z.string().optional(),
  /** Durée en ms. */
  durationMs: z.number().int().nonnegative().default(0),
});

export type CorrectionResult = z.infer<typeof correctionResultSchema>;
