import { z } from "zod";
import { idSchema } from "./common";
import { workerKindSchema } from "./task-execution";

/**
 * Task requirements for AI selection.
 */
export const TaskRequirementsSchema = z.object({
  /** Required capability (e.g., "text-generation", "image-classification") */
  capabilityRequired: z.string().min(1),
  /** Preferred worker kinds (optional, empty means no preference) */
  workerKindPreferred: z.array(workerKindSchema).default([]),
  /** Allowed worker kinds (if empty, all are allowed) */
  workerKindAllowed: z.array(workerKindSchema).default([]),
  /** Sensitivity level of the task */
  sensitivity: z.enum(["read_only", "reversible", "sensitive"]).default("reversible"),
  /** Whether the task requires tool usage */
  requiresTools: z.boolean().default(false),
  /** Whether the task requires structured output (JSON) */
  requiresStructuredOutput: z.boolean().default(false),
  /** Minimum context window size (in tokens) */
  minContextWindow: z.number().int().positive().default(1024),
  /** Maximum latency in us */
  maxLatencyMs: z.number().int().nonnegative().optional(),
  /** Maximum cost (in USD) */
  maxCost: z.number().nonnegative().optional(),
  /** Preferred providers (if empty, no preference) */
  preferredProviders: z.array(z.string()).default([]),
  /** Forbidden providers */
  forbiddenProviders: z.array(z.string()).default([]),
  /** Preferred models (if empty, no preference) */
  preferredModels: z.array(z.string()).default([]),
  /** Forbidden models */
  forbiddenModels: z.array(z.string()).default([]),
  /** Required features (e.g., "vision", "function_calling") */
  requiredFeatures: z.array(z.string()).default([]),
  /** Quality target (0-1) */
  qualityTarget: z.number().min(0).max(1).default(0.8),
  /** Reliability target (0-1) */
  reliabilityTarget: z.number().min(0).max(1).default(0.9),
});

export type TaskRequirements = z.infer<typeof TaskRequirementsSchema>;

/**
 * A candidate worker kind with its properties.
 */
export const WorkerCandidateSchema = z.object({
  /** Worker kind identifier */
  workerKind: workerKindSchema,
  /** Capabilities this worker can handle */
  capabilities: z.array(z.string()),
  /** Whether this worker supports tool usage */
  supportsTools: z.boolean().default(false),
  /** Whether this worker supports structured output */
  supportsStructuredOutput: z.boolean().default(false),
  /** Typical latency in milliseconds */
  typicalLatencyMs: z.number().int().nonnegative(),
  /** Typical cost per unit (e.g., per 1k tokens) */
  typicalCostPerUnit: z.number().nonnegative(),
  /** Context window size */
  contextWindow: z.number().int().positive(),
  /** Reliability score (0-1) */
  reliability: z.number().min(0).max(1),
  /** Quality score (0-1) */
  quality: z.number().min(0).max(1),
  /** Additional features */
  features: z.array(z.string()).default([]),
});

export type WorkerCandidate = z.infer<typeof WorkerCandidateSchema>;

/**
 * A candidate model with its properties.
 */
export const ModelCandidateSchema = z.object({
  /** Model identifier */
  modelId: z.string().min(1),
  /** Provider that offers this model */
  provider: z.string().min(1),
  /** Capabilities this model supports */
  capabilities: z.array(z.string()),
  /** Whether this model supports tool usage */
  supportsTools: z.boolean().default(false),
  /** Whether this model supports structured output */
  supportsStructuredOutput: z.boolean().default(false),
  /** Context window size */
  contextWindow: z.number().int().positive(),
  /** Typical latency in milliseconds */
  typicalLatencyMs: z.number().int().nonnegative(),
  /** Typical cost per unit (e.g., per 1k tokens) */
  typicalCostPerUnit: z.number().nonnegative(),
  /** Reliability score (0-1) */
  reliability: z.number().min(0).max(1),
  /** Quality score (0-1) */
  quality: z.number().min(0).max(1),
  /** Additional features */
  features: z.array(z.string()).default([]),
});

export type ModelCandidate = z.infer<typeof ModelCandidateSchema>;

/**
 * A candidate provider with its properties.
 */
export const ProviderCandidateSchema = z.object({
  /** Provider identifier */
  providerId: z.string().min(1),
  /** Health status (0-1) */
  health: z.number().min(0).max(1).default(1),
  /** Availability (true if operational) */
  isAvailable: z.boolean().default(true),
  /** List of offered models */
  offeredModels: z.array(z.string()),
  /** Trust level (0-1) */
  trust: z.number().min(0).max(1).default(0.5),
  /** Security level (0-1) */
  security: z.number().min(0).max(1).default(0.5),
});

export type ProviderCandidate = z.infer<typeof ProviderCandidateSchema>;

/**
 * Selection policy (can be extended with more rules).
 */
export const SelectionPolicySchema = z.object({
  /** Whether to allow fallback */
  allowFallback: z.boolean().default(true),
  /** Weight for capability fit (0-1) */
  weightCapabilityFit: z.number().min(0).max(1).default(0.25),
  /** Weight for quality (0-1) */
  weightQuality: z.number().min(0).max(1).default(0.2),
  /** Weight for reliability (0-1) */
  weightReliability: z.number().min(0).max(1).default(0.15),
  /** Weight for latency (0-1, lower is better) */
  weightLatency: z.number().min(0).max(1).default(0.1),
  /** Weight for cost (0-1, lower is better) */
  weightCost: z.number().min(0).max(1).default(0.1),
  /** Weight for context headroom (0-1, higher is better) */
  weightContextHeadroom: z.number().min(0).max(1).default(0.05),
  /** Weight for feature fit (0-1) */
  weightFeatureFit: z.number().min(0).max(1).default(0.05),
  /** Weight for provider health (0-1) */
  weightProviderHealth: z.number().min(0).max(1).default(0.025),
  /** Weight for trust (0-1) */
  weightTrust: z.number().min(0).max(1).default(0.025),
  /** Weight for provider preference (0-1) */
  weightProviderPreference: z.number().min(0).max(1).default(0.025),
  /** Weight for model preference (0-1) */
  weightModelPreference: z.number().min(0).max(1).default(0.025),
});

export type SelectionPolicy = z.infer<typeof SelectionPolicySchema>;

/**
 * Selection constraints (derived from task requirements and policy).
 */
export const SelectionConstraintsSchema = z.object({
  /** Required capability */
  capabilityRequired: z.string().min(1),
  /** Sensitivity level */
  sensitivity: z.enum(["read_only", "reversible", "sensitive"]),
  /** Requires tools */
  requiresTools: z.boolean(),
  /** Requires structured output */
  requiresStructuredOutput: z.boolean(),
  /** Minimum context window */
  minContextWindow: z.number().int().positive(),
  /** Maximum latency (optional) */
  maxLatencyMs: z.number().int().nonnegative().optional(),
  /** Maximum cost (optional) */
  maxCost: z.number().nonnegative().optional(),
  /** Forbidden providers */
  forbiddenProviders: z.array(z.string()),
  /** Forbidden models */
  forbiddenModels: z.array(z.string()),
  /** Required features */
  requiredFeatures: z.array(z.string()),
  /** Quality target */
  qualityTarget: z.number().min(0).max(1),
  /** Reliability target */
  reliabilityTarget: z.number().min(0).max(1),
  /** Allowed worker kinds (if empty, all are allowed) */
  workerKindAllowed: z.array(workerKindSchema),
  /** Preferred worker kinds (empty means no preference) */
  workerKindPreferred: z.array(workerKindSchema),
});

export type SelectionConstraints = z.infer<typeof SelectionConstraintsSchema>;

/**
 * Score breakdown for a candidate.
 */
export const SelectionScoreSchema = z.object({
  /** Overall score (0-100) */
  overall: z.number().min(0).max(100),
  /** Capability fit score (0-100) */
  capabilityFit: z.number().min(0).max(100),
  /** Quality score (0-100) */
  quality: z.number().min(0).max(100),
  /** Reliability score (0-100) */
  reliability: z.number().min(0).max(100),
  /** Latency score (0-100, lower latency -> higher score) */
  latency: z.number().min(0).max(100),
  /** Cost score (0-100, lower cost -> higher score) */
  cost: z.number().min(0).max(100),
  /** Context headroom score (0-100, more headroom -> higher score) */
  contextHeadroom: z.number().min(0).max(100),
  /** Feature fit score (0-100) */
  featureFit: z.number().min(0).max(100),
  /** Provider health score (0-100) */
  providerHealth: z.number().min(0).max(100),
  /** Trust score (0-100) */
  trust: z.number().min(0).max(100),
});

export type SelectionScore = z.infer<typeof SelectionScoreSchema>;

/**
 * A rejected candidate with reason.
 */
export const RejectedCandidateSchema = z.object({
  /** The candidate that was rejected */
  candidateId: z.string(),
  /** Reason for rejection */
  reason: z.enum([
    "CAPABILITY_MISMATCH",
    "PROVIDER_FORBIDDEN",
    "MODEL_FORBIDDEN",
    "TOOLS_UNSUPPORTED",
    "STRUCTURED_OUTPUT_UNSUPPORTED",
    "CONTEXT_TOO_SMALL",
    "BUDGET_EXCEEDED",
    "LATENCY_EXCEEDED",
    "PROVIDER_UNAVAILABLE",
    "MODEL_UNAVAILABLE",
    "SENSITIVITY_POLICY_BLOCK",
    "FEATURE_MISSING",
    "WORKER_KIND_NOT_ALLOWED",
    "QUALITY_TARGET_NOT_MET",
    "RELIABILITY_TARGET_NOT_MET",
  ]),
  /** Optional details */
  details: z.string().optional(),
});

export type RejectedCandidate = z.infer<typeof RejectedCandidateSchema>;

/**
 * Fallback plan (ordered list of candidates).
 */
export const FallbackPlanSchema = z.array(
  z.object({
    workerKind: workerKindSchema,
    modelId: z.string(),
    providerId: z.string(),
  })
);

export type FallbackPlan = z.infer<typeof FallbackPlanSchema>;

/**
 * The final selection decision (discriminated union).
 */
export const SelectionDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("selected"),
    /** Selected worker kind */
    selectedWorkerKind: workerKindSchema,
    /** Selected model ID */
    selectedModelId: z.string(),
    /** Selected provider ID */
    selectedProviderId: z.string(),
    /** Score breakdown */
    score: SelectionScoreSchema,
    /** Rationale for the selection */
    rationale: z.string(),
    /** Evidence supporting the decision */
    evidence: z.array(z.string()).default([]),
    /** Fallback plan */
    fallbackPlan: FallbackPlanSchema,
    /** List of rejected candidates with reasons */
    rejectedCandidates: z.array(RejectedCandidateSchema),
  }),
  z.object({
    status: z.literal("no_viable_candidate"),
    /** Selected worker kind (null when no viable candidate) */
    selectedWorkerKind: z.null(),
    /** Selected model ID (null when no viable candidate) */
    selectedModelId: z.null(),
    /** Selected provider ID (null when no viable candidate) */
    selectedProviderId: z.null(),
    /** Score breakdown (all zero) */
    score: z.object({
      overall: z.number().min(0).max(100).default(0),
      capabilityFit: z.number().min(0).max(100).default(0),
      quality: z.number().min(0).max(100).default(0),
      reliability: z.number().min(0).max(100).default(0),
      latency: z.number().min(0).max(100).default(0),
      cost: z.number().min(0).max(100).default(0),
      contextHeadroom: z.number().min(0).max(100).default(0),
      featureFit: z.number().min(0).max(100).default(0),
      providerHealth: z.number().min(0).max(100).default(0),
      trust: z.number().min(0).max(100).default(0),
    }),
    /** Rationale for the selection */
    rationale: z.string(),
    /** Evidence supporting the decision */
    evidence: z.array(z.string()).default([]),
    /** Fallback plan (empty when no viable candidate) */
    fallbackPlan: z.array(
      z.object({
        workerKind: workerKindSchema,
        modelId: z.string(),
        providerId: z.string(),
      })
    ).default([]),
    /** List of rejected candidates with reasons */
    rejectedCandidates: z.array(RejectedCandidateSchema),
    /** Reason for no viable candidate */
    reason: z.enum(["NO_VIABLE_CANDIDATE"]),
  }),
]);

export type SelectionDecision = z.infer<typeof SelectionDecisionSchema>;

/**
 * Port abstraction for AI resource catalog.
 * Allows the selection engine to depend on an interface rather than concrete catalog.
 */
export interface AIResourceCatalogPort {
  listWorkers(): WorkerCandidate[];
  listModels(): ModelCandidate[];
  listProviders(): ProviderCandidate[];
  isProviderAvailable(providerId: string): boolean;
  isModelOffered(modelId: string, providerId: string): boolean;
  /**
   * Returns a deterministic snapshot of the catalog state.
   * The snapshot must be a consistent point-in-time view.
   */
  snapshot(): {
    workers: WorkerCandidate[];
    models: ModelCandidate[];
    providers: ProviderCandidate[];
  };
}