import { z } from "zod";

import { isoDateTimeSchema } from "@/core/contracts/common";

// ─────────────────────────────────────
// Worktree status
// ─────────────────────────────────────

export const worktreeStatusSchema = z.enum(["CREATED", "ACTIVE", "COMMITTED", "DIRTY", "CLEANED"]);

export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;

// ─────────────────────────────────────
// WorktreeSpec
// ─────────────────────────────────────

export const worktreeSpecSchema = z.object({
  /** Chemin absolu du worktree. */
  path: z.string().min(1),
  /** Nom de la branche. */
  branch: z.string().min(1),
  /** SHA du commit de base. */
  baseSha: z
    .string()
    .length(40)
    .regex(/^[0-9a-f]{40}$/),
  /** ID de la tâche assignée. */
  taskId: z.string().min(1),
});

export type WorktreeSpec = z.infer<typeof worktreeSpecSchema>;

// ─────────────────────────────────────
// WorktreeResult
// ─────────────────────────────────────

export const worktreeResultSchema = z.object({
  /** SHA du commit de base. */
  baseSha: z.string().min(1),
  /** SHA du HEAD après travail (peut être le même si non commité). */
  headSha: z.string().min(1),
  /** Fichiers modifiés par rapport à baseSha. */
  changedFiles: z.array(z.string()).default([]),
  /** Vrai si le worktree a des modifications non commitées. */
  isDirty: z.boolean().default(false),
  /** Fichiers modifiés non commités. */
  uncommittedFiles: z.array(z.string()).default([]),
  /** Messages des commits effectués. */
  commitMessages: z.array(z.string()).default([]),
  /** SHA des commits effectués. */
  commitShas: z.array(z.string()).default([]),
});

export type WorktreeResult = z.infer<typeof worktreeResultSchema>;

// ─────────────────────────────────────
// Worktree entry (full state)
// ─────────────────────────────────────

export const worktreeEntrySchema = z.object({
  spec: worktreeSpecSchema,
  status: worktreeStatusSchema.default("CREATED"),
  result: worktreeResultSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type WorktreeEntry = z.infer<typeof worktreeEntrySchema>;
