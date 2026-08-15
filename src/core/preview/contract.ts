import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

// ─────────────────────────────────────
// Preview delivery status
// ─────────────────────────────────────

export const previewStatusSchema = z.enum(["LOCAL_RESULT_READY", "WAITING_FOR_HUMAN", "FAILED"]);

export type PreviewStatus = z.infer<typeof previewStatusSchema>;

// ─────────────────────────────────────
// PreviewResult
// ─────────────────────────────────────

export const previewResultSchema = z.object({
  /** Statut de la livraison. */
  status: previewStatusSchema,
  /** Chemin local du résultat (présent si LOCAL_RESULT_READY). */
  localPath: z.string().optional(),
  /** SHA final de la branche d'intégration. */
  integrationSha: z.string().optional(),
  /** Nom de la branche d'intégration. */
  integrationBranch: z.string().optional(),
  /** Résumé de ce qui a été produit. */
  summary: z.string(),
  /** Raison du WAITING_FOR_HUMAN. */
  humanGateReason: z.string().optional(),
  /** Durée en ms. */
  durationMs: z.number().int().nonnegative().default(0),
  /** Horodatage. */
  completedAt: isoDateTimeSchema,
});

export type PreviewResult = z.infer<typeof previewResultSchema>;
