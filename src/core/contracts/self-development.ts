import { z } from "zod";

import { idSchema, isoDateTimeSchema, jsonValueSchema, type JsonValue } from "./common";

/**
 * États du cycle de vie d'auto-développement.
 * Fail-closed par défaut : tout état inconnu → HUMAN_DECISION_REQUIRED.
 */
export const selfDevelopmentStateSchema = z.enum([
  "candidate_received",
  "policy_evaluation",
  "repair_requested",
  "review_result",
  "accepted",
  "exhausted",
  "human_decision_required",
]);

export type SelfDevelopmentState = z.infer<typeof selfDevelopmentStateSchema>;

/**
 * Résultat d'évaluation de politique.
 */
export const policyEvaluationResultSchema = z.enum(["allow", "deny", "repair"]);

export type PolicyEvaluationResult = z.infer<typeof policyEvaluationResultSchema>;

/**
 * Résultat de revue.
 */
export const reviewResultSchema = z.enum(["approved", "rejected", "needs_repair"]);

export type ReviewResult = z.infer<typeof reviewResultSchema>;

/**
 * Candidat d'auto-développement (entrée du contrôleur).
 */
export const selfDevelopmentCandidateSchema = z.object({
  candidateId: idSchema,
  missionId: idSchema,
  proposal: z.object({
    type: z.enum(["skill_improvement", "workflow_optimization", "policy_adjustment"]),
    description: z.string().min(1),
    payload: z.record(z.string(), jsonValueSchema),
  }),
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  submittedAt: isoDateTimeSchema,
});

export type SelfDevelopmentCandidate = z.infer<typeof selfDevelopmentCandidateSchema>;

/**
 * Résultat de l'évaluation de politique.
 */
export const policyEvaluationSchema = z.object({
  candidateId: idSchema,
  result: policyEvaluationResultSchema,
  reason: z.string().min(1),
  maxRepairAttempts: z.number().int().min(0).default(3),
  evaluatedAt: isoDateTimeSchema,
});

export type PolicyEvaluation = z.infer<typeof policyEvaluationSchema>;

/**
 * Demande de réparation.
 */
export const repairRequestSchema = z.object({
  candidateId: idSchema,
  attemptNumber: z.number().int().min(1),
  previousFeedback: z.string().optional(),
  requestedAt: isoDateTimeSchema,
});

export type RepairRequest = z.infer<typeof repairRequestSchema>;

/**
 * Résultat de réparation.
 */
export const repairResultSchema = z.object({
  candidateId: idSchema,
  attemptNumber: z.number().int().min(1),
  success: z.boolean(),
  repairedProposal: z.record(z.string(), jsonValueSchema).optional(),
  error: z.string().optional(),
  completedAt: isoDateTimeSchema,
});

export type RepairResult = z.infer<typeof repairResultSchema>;

/**
 * Résultat de revue.
 */
export const reviewOutcomeSchema = z.object({
  candidateId: idSchema,
  result: reviewResultSchema,
  reason: z.string().min(1),
  reviewedAt: isoDateTimeSchema,
});

export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

/**
 * Résultat final du cycle d'auto-développement.
 */
export const selfDevelopmentOutcomeSchema = z.object({
  candidateId: idSchema,
  finalState: selfDevelopmentStateSchema,
  acceptedProposal: z.record(z.string(), jsonValueSchema).optional(),
  rejectionReason: z.string().optional(),
  repairAttemptsUsed: z.number().int().min(0).default(0),
  completedAt: isoDateTimeSchema,
});

export type SelfDevelopmentOutcome = z.infer<typeof selfDevelopmentOutcomeSchema>;

/**
 * Port pour l'évaluation de politique (à implémenter par Worker B).
 */
export interface PolicyEvaluationPort {
  evaluate(candidate: SelfDevelopmentCandidate): Promise<PolicyEvaluation>;
}

/**
 * Port pour la réparation bornée (à implémenter par Worker C).
 */
export interface BoundedRepairPort {
  requestRepair(request: RepairRequest): Promise<RepairResult>;
  getMaxAttempts(candidateId: string): Promise<number>;
}

/**
 * Port pour la revue indépendante (à implémenter par Worker D).
 */
export interface IndependentReviewPort {
  review(candidateId: string, proposal: Record<string, JsonValue>): Promise<ReviewOutcome>;
}

/**
 * Port pour la mémoire durable (existant).
 */
export interface SelfDevelopmentMemoryPort {
  saveOutcome(outcome: SelfDevelopmentOutcome): Promise<void>;
  getOutcome(candidateId: string): Promise<SelfDevelopmentOutcome | null>;
  listOutcomes(missionId: string): Promise<SelfDevelopmentOutcome[]>;
}

/**
 * Port pour les métriques (implémenté ici).
 */
export interface SelfDevelopmentMetricsPort {
  recordCycle(): void;
  recordCandidateProcessed(): void;
  recordRepairAttempted(): void;
  recordRepairAccepted(): void;
  recordRepairRejected(): void;
  recordRepairExhausted(): void;
  recordHumanEscalation(): void;
  recordPatternLearned(): void;
  getSnapshot(): SelfDevelopmentMetricsSnapshot;
}

/**
 * Snapshot des métriques.
 */
export const selfDevelopmentMetricsSnapshotSchema = z.object({
  cyclesTotal: z.number().int().min(0),
  candidatesProcessed: z.number().int().min(0),
  repairsAttempted: z.number().int().min(0),
  repairsAccepted: z.number().int().min(0),
  repairsRejected: z.number().int().min(0),
  repairsExhausted: z.number().int().min(0),
  humanEscalations: z.number().int().min(0),
  patternsLearned: z.number().int().min(0),
  capturedAt: isoDateTimeSchema,
});

export type SelfDevelopmentMetricsSnapshot = z.infer<
  typeof selfDevelopmentMetricsSnapshotSchema
>;