import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Décision de revue automatique canonique.
 * Actions de contrôle qualité exhaustives et mutuellement exclusives.
 */
export const reviewDecisionSchema = z.enum([
  "APPROVE",
  "REQUEST_CHANGES",
  "RETRY",
  "REPLAN",
  "BLOCK",
  "ESCALATE_TO_HUMAN",
]);

/**
 * Source de la revue pour auditabilité.
 */
export const reviewerKindSchema = z.enum(["deterministic", "llm"]);

/**
 * Sévérité associée à une décision (utile pour tri/filtre).
 */
export const reviewSeveritySchema = z.enum(["info", "warning", "critical"]);

/**
 * Changement demandé structuré (pour REQUEST_CHANGES).
 */
export const requestedChangeSchema = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
  suggestion: z.string().optional(),
});

/**
 * Métadonnées du provider LLM (pour auditabilité future provider diversity).
 */
export const reviewerProviderMetadataSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().optional(),
    promptVersion: z.string().optional(),
  })
  .optional();

/**
 * Révision canonique d'un résultat d'exécution.
 */
export const reviewDecisionRecordSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    workflowId: idSchema,
    missionId: idSchema, // made required
    decision: reviewDecisionSchema,
    reviewerKind: reviewerKindSchema,
    severity: reviewSeveritySchema,
    /** Raisons structurées (toujours présentes, même pour APPROVE). */
    reasons: z.array(z.string().min(1)).min(1),
    /** Changements demandés si décision = REQUEST_CHANGES. */
    requestedChanges: z.array(requestedChangeSchema).optional(),
    /** Références aux preuves examinées. */
    evidenceRefs: z.array(idSchema).optional(),
    /** Références aux findings examinés. */
    findingRefs: z.array(z.string()).optional(),
    /** Références aux politiques/règles déclenchées. */
    policyRefs: z.array(z.string()).optional(),
    /** Métadonnées du provider LLM (pour auditabilité future provider diversity). */
    providerMetadata: reviewerProviderMetadataSchema,
    /** Confiance du reviewer LLM (0-1), si applicable. */
    confidence: z.number().min(0).max(1).optional(),
    /** Timestamp de la décision. */
    createdAt: isoDateTimeSchema,
    /** Si la décision a été escaladée humainement après coup. */
    humanOverridden: z.boolean().default(false),
    /** ID de la décision humaine qui a overriding (si applicable). */
    overriddenBy: idSchema.optional(),
  })
  .strict();

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type ReviewerKind = z.infer<typeof reviewerKindSchema>;
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;
export type RequestedChange = z.infer<typeof requestedChangeSchema>;
export type ReviewerProviderMetadata = z.infer<typeof reviewerProviderMetadataSchema>;
export type ReviewDecisionRecord = z.infer<typeof reviewDecisionRecordSchema>;
