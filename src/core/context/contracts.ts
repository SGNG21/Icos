import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";
import { MissionStatusSchema, MissionTaskStatusSchema } from "@/core/mission/contracts";
import {
  taskExecutionResultSchema,
  artifactSchema,
  evidenceSchema,
  findingSchema,
  workerKindSchema,
} from "@/core/contracts/task-execution";

/**
 * A compact representation of mission state at a point in time.
 * Used for checkpoints and handoffs.
 */
export const checkpointSchema = z.object({
  id: idSchema,
  missionId: z.string(),
  label: z.string().optional(),
  createdAt: isoDateTimeSchema,
  version: z.number().int().positive().default(1),

  // Core mission state
  mission: z.object({
    id: z.string(),
    title: z.string(),
    objective: z.string(),
    status: z.string(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema.optional(),
  }),

  // All tasks with current status
  tasks: z.array(
    z.object({
      id: z.string(),
      missionId: z.string(),
      title: z.string(),
      description: z.string().optional().nullable(),
      dependsOn: z.array(z.string()),
      status: MissionTaskStatusSchema,
      workerKind: z.string().optional().nullable(),
      capability: z.string().optional().nullable(),
      taskId: z.string(),
    }),
  ),

  // Completed task results (keyed by taskId)
  taskResults: z.record(z.string(), taskExecutionResultSchema).optional(),

  // All decisions
  decisions: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        workflowId: z.string(),
        missionId: z.string(),
        decision: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK", "ESCALATE_TO_HUMAN"]),
        reviewerKind: z.enum(["deterministic", "llm", "human"]),
        severity: z.enum(["info", "warning", "critical"]),
        reasons: z.array(z.string()),
        requestedChanges: z
          .array(
            z.object({
              field: z.string(),
              reason: z.string(),
              suggestedValue: z.unknown().optional(),
            }),
          )
          .optional(),
        evidenceRefs: z.array(z.string()),
        findingRefs: z.array(z.string()),
        policyRefs: z.array(z.string()),
        providerMetadata: z
          .object({
            provider: z.string(),
            model: z.string(),
            temperature: z.number().optional(),
            promptVersion: z.string().optional(),
          })
          .optional(),
        confidence: z.number().optional(),
        createdAt: isoDateTimeSchema,
        humanOverridden: z.boolean(),
        overriddenBy: z.string().optional(),
      }),
    )
    .optional(),

  // All artifacts
  artifacts: z
    .array(
      z.object({
        type: z.string(),
        path: z.string().optional(),
        url: z.string().url().optional(),
        mediaType: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),

  // All evidence
  evidence: z
    .array(
      z.object({
        type: z.string(),
        source: z.string(),
        path: z.string().optional(),
        url: z.string().url().optional(),
        timestamp: z.string().datetime(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),

  // All errors
  errors: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
      }),
    )
    .optional(),

  // Metadata
  tokenCount: z.number().int().nonnegative().optional(),
  compressed: z.boolean().default(false),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

/**
 * Reference to a checkpoint (for listing)
 */
export const checkpointRefSchema = z.object({
  id: idSchema,
  missionId: z.string(),
  label: z.string().optional(),
  createdAt: isoDateTimeSchema,
  tokenCount: z.number().int().nonnegative().optional(),
});

export type CheckpointRef = z.infer<typeof checkpointRefSchema>;

/**
 * A decision record
 */
export const decisionRecordSchema = z.object({
  id: idSchema,
  taskId: z.string(),
  workflowId: z.string(),
  missionId: z.string(),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCK", "ESCALATE_TO_HUMAN"]),
  reviewerKind: z.enum(["deterministic", "llm", "human"]),
  severity: z.enum(["info", "warning", "critical"]),
  reasons: z.array(z.string()),
  requestedChanges: z
    .array(
      z.object({
        field: z.string(),
        reason: z.string(),
        suggestedValue: z.unknown().optional(),
      }),
    )
    .optional(),
  evidenceRefs: z.array(z.string()),
  findingRefs: z.array(z.string()),
  policyRefs: z.array(z.string()),
  providerMetadata: z
    .object({
      provider: z.string(),
      model: z.string(),
      temperature: z.number().optional(),
      promptVersion: z.string().optional(),
    })
    .optional(),
  confidence: z.number().optional(),
  createdAt: isoDateTimeSchema,
  humanOverridden: z.boolean(),
  overriddenBy: z.string().optional(),
});

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

/**
 * Learned pattern from execution history (factual evidence only)
 */
export const learnedPatternSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  // Pattern signature (what triggers it)
  signature: z.object({
    capability: z.string().optional(),
    workerKind: z.string().optional(),
    errorCode: z.string().optional(),
    findingCategory: z.string().optional(),
    taskTitleKeywords: z.array(z.string()).optional(),
  }),
  // Outcome
  outcome: z.enum(["success", "failure", "mixed"]),
  // Observations
  observations: z.array(z.string()),
  // How many times observed
  occurrenceCount: z.number().int().positive(),
  // Outcome counts per result type
  outcomeCounts: z.object({
    success: z.number().int().nonnegative(),
    failure: z.number().int().nonnegative(),
    mixed: z.number().int().nonnegative(),
  }),
  // First time this pattern was seen
  firstSeenAt: isoDateTimeSchema,
  // Last time this pattern was seen
  lastSeenAt: isoDateTimeSchema,
  // Created
  createdAt: isoDateTimeSchema,
  // Evidence references that support this pattern
  evidenceRefs: z.array(z.string()),
  // Durable factual source identities already included in this aggregate.
  // Used to make repeated harvesting idempotent without synthetic scoring.
  sourceOutcomeIds: z.array(z.string()).optional(),
  // Real mission identities represented by this factual aggregate.
  missionIds: z.array(z.string()).optional(),
});

export type LearnedPattern = z.infer<typeof learnedPatternSchema>;

/**
 * Agent preferences (calibrated behaviors)
 */
export const agentPreferencesSchema = z.object({
  agentId: z.string(),
  // Preferred worker for capabilities
  preferredWorkers: z.record(z.string(), z.string()).optional(),
  // Risk tolerance
  riskTolerance: z.enum(["conservative", "balanced", "aggressive"]).default("balanced"),
  // Auto-approval thresholds
  autoApproveThresholds: z.record(z.string(), z.number()).optional(),
  // Tool preferences
  toolPreferences: z.record(z.string(), z.unknown()).optional(),
  // Updated
  updatedAt: isoDateTimeSchema,
});

export type AgentPreferences = z.infer<typeof agentPreferencesSchema>;

/**
 * Reusable context template
 */
export const contextTemplateSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  // Template content with placeholders
  template: z.string(),
  // Required variables
  variables: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      description: z.string(),
      required: z.boolean().default(true),
    }),
  ),
  // Tags for discovery
  tags: z.array(z.string()).optional(),
  // Usage count
  usageCount: z.number().int().nonnegative().default(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type ContextTemplate = z.infer<typeof contextTemplateSchema>;

/**
 * Tool calibration data
 */
export const toolCalibrationSchema = z.object({
  toolId: z.string(),
  agentId: z.string(),
  // Success rate 0-1
  successRate: z.number().min(0).max(1),
  // Average latency ms
  avgLatencyMs: z.number().int().nonnegative(),
  // Error patterns
  commonErrors: z.array(z.string()).optional(),
  // Best parameters
  bestParams: z.record(z.string(), z.unknown()).optional(),
  // Sample size
  sampleSize: z.number().int().positive(),
  updatedAt: isoDateTimeSchema,
});

export type ToolCalibration = z.infer<typeof toolCalibrationSchema>;

/**
 * Working memory for an agent session
 */
export const workingMemorySchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  patterns: z.array(learnedPatternSchema).default([]),
  preferences: agentPreferencesSchema.optional(),
  templates: z.array(contextTemplateSchema).default([]),
  crossMissionDecisions: z.array(decisionRecordSchema).default([]),
  toolCalibration: z.array(toolCalibrationSchema).default([]),
  tokenEstimate: z.number().int().nonnegative().default(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type WorkingMemory = z.infer<typeof workingMemorySchema>;

/**
 * Handoff package for agent-to-agent transfer
 */
export const handoffPackageSchema = z.object({
  id: idSchema,
  missionId: z.string(),
  fromAgent: z.string(),
  toAgent: z.string(),
  timestamp: isoDateTimeSchema,
  reason: z.enum(["specialization", "failure", "human_request", "load_balance"]),
  instructions: z.string().optional(),
  // Full mission context (hot layer)
  missionContext: z.object({
    mission: z.object({
      id: z.string(),
      title: z.string(),
      objective: z.string(),
      status: z.string(),
      createdAt: isoDateTimeSchema,
      updatedAt: isoDateTimeSchema,
    }),
    tasks: z.array(
      z.object({
        id: z.string(),
        missionId: z.string(),
        title: z.string(),
        description: z.string().optional().nullable(),
        dependsOn: z.array(z.string()),
        status: MissionTaskStatusSchema,
        workerKind: z.string().optional().nullable(),
        capability: z.string().optional().nullable(),
        taskId: z.string(),
      }),
    ),
    taskResults: z.record(z.string(), z.any()).optional(),
    recentDecisions: z.array(decisionRecordSchema).default([]),
    currentArtifacts: z
      .array(
        z.object({
          type: z.string(),
          path: z.string().optional(),
          url: z.string().url().optional(),
          mediaType: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .default([]),
    evidence: z
      .array(
        z.object({
          type: z.string(),
          source: z.string(),
          path: z.string().optional(),
          url: z.string().url().optional(),
          timestamp: z.string().datetime(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .default([]),
    errors: z
      .array(
        z.object({
          code: z.string(),
          message: z.string(),
        }),
      )
      .default([]),
    checkpoints: z.array(checkpointRefSchema).default([]),
    tokenEstimate: z.number().int().nonnegative(),
  }),
  // Working memory slice
  workingMemorySlice: z
    .object({
      patterns: z.array(learnedPatternSchema).default([]),
      templates: z.array(contextTemplateSchema).default([]),
      calibration: z.array(toolCalibrationSchema).default([]),
    })
    .optional(),
  // Durable references
  durableRefs: z
    .object({
      checkpointId: z.string(),
      decisionIds: z.array(z.string()).default([]),
      resultIds: z.array(z.string()).default([]),
    })
    .optional(),
});

export type HandoffPackage = z.infer<typeof handoffPackageSchema>;

/**
 * Context query for selection
 */
export const contextQuerySchema = z.object({
  missionId: z.string(),
  taskId: z.string().optional(),
  capability: z.string().optional(),
  workerKind: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  maxTokens: z.number().int().positive().optional(),
  includeHistory: z.boolean().default(false),
  scope: z.enum(["mission", "task", "agent", "global"]).optional(),
});

export type ContextQuery = z.infer<typeof contextQuerySchema>;

/**
 * Selection result
 */
export const selectionResultSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      scope: z.enum(["mission", "task", "agent", "global"]),
      type: z.string(),
      summary: z.string(),
      contentReference: z.string().optional(),
      createdAt: isoDateTimeSchema,
      updatedAt: isoDateTimeSchema.optional(),
      priority: z.number().int().min(0).max(100).optional(),
      expiresAt: isoDateTimeSchema.optional(),
      tokenEstimate: z.number().int().nonnegative().optional(),
    }),
  ),
  totalTokens: z.number().int().nonnegative(),
  dropped: z.array(
    z.object({
      id: idSchema,
      reason: z.string(),
      tokenEstimate: z.number().int().nonnegative(),
    }),
  ),
  summary: z.string(),
});

export type SelectionResult = z.infer<typeof selectionResultSchema>;

/**
 * Compacted context for LLM
 */
export const compactedContextSchema = z.object({
  mission: z.object({
    id: z.string(),
    title: z.string(),
    objective: z.string(),
    status: z.string(),
  }),
  activeTasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional().nullable(),
      status: z.string(),
      workerKind: z.string().optional().nullable(),
      capability: z.string().optional().nullable(),
    }),
  ),
  readyTasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional().nullable(),
      workerKind: z.string().optional().nullable(),
      capability: z.string().optional().nullable(),
    }),
  ),
  recentDecisions: z
    .array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        decision: z.string(),
        reasons: z.array(z.string()),
        reviewerKind: z.string(),
        createdAt: isoDateTimeSchema,
      }),
    )
    .default([]),
  keyArtifacts: z
    .array(
      z.object({
        type: z.string(),
        summary: z.string(),
        url: z.string().url().optional(),
      }),
    )
    .default([]),
  keyEvidence: z
    .array(
      z.object({
        type: z.string(),
        source: z.string(),
        summary: z.string(),
      }),
    )
    .default([]),
  blockingErrors: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        taskId: z.string().optional(),
      }),
    )
    .default([]),
  pendingApprovals: z
    .array(
      z.object({
        taskId: z.string(),
        title: z.string(),
        requestedAt: isoDateTimeSchema,
      }),
    )
    .default([]),
  summary: z.string(),
  tokenCount: z.number().int().nonnegative(),
  droppedSummary: z.string().optional(),
});

export type CompactedContext = z.infer<typeof compactedContextSchema>;

/**
 * Compaction result
 */
export const compactionResultSchema = z.object({
  originalTokens: z.number().int().nonnegative(),
  compactedTokens: z.number().int().nonnegative(),
  reductionPercent: z.number().min(0).max(100),
  criticalKept: z.number().int().nonnegative(),
  highPriorityKept: z.number().int().nonnegative(),
  mediumSummarized: z.number().int().nonnegative(),
  lowDropped: z.number().int().nonnegative(),
  details: z.array(
    z.object({
      category: z.string(),
      kept: z.number().int().nonnegative(),
      summarized: z.number().int().nonnegative(),
      dropped: z.number().int().nonnegative(),
    }),
  ),
});

export type CompactionResult = z.infer<typeof compactionResultSchema>;

/**
 * Consistency report after restore
 */
export const consistencyReportSchema = z.object({
  missionId: z.string(),
  checkpointId: z.string(),
  checkedAt: isoDateTimeSchema,
  isConsistent: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      category: z.string(),
      message: z.string(),
      taskId: z.string().optional(),
    }),
  ),
  autoRepaired: z.array(z.string()).default([]),
});

export type ConsistencyReport = z.infer<typeof consistencyReportSchema>;
