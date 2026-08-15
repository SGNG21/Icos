import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

// ─────────────────────────────────────
// Gate result
// ─────────────────────────────────────

export const gateResultSchema = z.object({
  /** Nom de la gate (ex: "lint", "typecheck", "test", "build"). */
  gate: z.string().min(1),
  /** Vrai si la gate est passée. */
  passed: z.boolean(),
  /** Sortie de la gate (stdout/stderr). */
  output: z.string().default(""),
  /** Durée d'exécution en ms. */
  durationMs: z.number().int().nonnegative().default(0),
  /** Erreur(s) rencontrée(s). */
  errors: z.array(z.string()).default([]),
});

export type GateResult = z.infer<typeof gateResultSchema>;

// ─────────────────────────────────────
// Integration status
// ─────────────────────────────────────

export const integrationStatusSchema = z.enum([
  "PENDING",
  "INTEGRATING",
  "CONFLICT",
  "GATES_PASSED",
  "GATES_FAILED",
  "SUCCEEDED",
  "FAILED",
]);

export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

// ─────────────────────────────────────
// Conflict info
// ─────────────────────────────────────

export const conflictInfoSchema = z.object({
  /** Fichiers en conflit. */
  files: z.array(z.string()).default([]),
  /** Vrai si le conflit peut être résolu automatiquement. */
  resolvable: z.boolean().default(false),
  /** Description du conflit. */
  description: z.string().default(""),
});

export type ConflictInfo = z.infer<typeof conflictInfoSchema>;

// ─────────────────────────────────────
// IntegrationSpec
// ─────────────────────────────────────

export const integrationSpecSchema = z.object({
  /** Identifiant de l'intégration. */
  id: idSchema,
  /** Mission propriétaire. */
  missionId: z.string().min(1),
  /** DAG source. */
  dagId: z.string().min(1),
  /** Commits à intégrer dans l'ordre topologique. */
  commits: z
    .array(
      z.object({
        taskId: z.string().min(1),
        commitSha: z.string().min(1),
        branch: z.string().min(1),
        worktreePath: z.string().min(1),
      }),
    )
    .min(1),
  /** Branche d'intégration. */
  integrationBranch: z.string().min(1).default("integration/candidate"),
  /** SHA de base (point de départ de l'intégration). */
  baseSha: z.string().optional(),
});

export type IntegrationSpec = z.infer<typeof integrationSpecSchema>;

// ─────────────────────────────────────
// IntegrationResult
// ─────────────────────────────────────

export const integrationResultSchema = z.object({
  /** Statut final de l'intégration. */
  status: integrationStatusSchema,
  /** Résultats des gates globales. */
  gateResults: z.array(gateResultSchema).default([]),
  /** Informations de conflit (si CONFLICT). */
  conflict: conflictInfoSchema.optional(),
  /** SHA final de la branche d'intégration. */
  finalSha: z.string().optional(),
  /** Nombre de commits intégrés. */
  commitsIntegrated: z.number().int().nonnegative().default(0),
  /** Résumé. */
  summary: z.string().default(""),
  /** Durée totale en ms. */
  durationMs: z.number().int().nonnegative().default(0),
});

export type IntegrationResult = z.infer<typeof integrationResultSchema>;
