import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * High-level goal as provided by a human user, before normalization.
 */
export const HighLevelGoalInputSchema = z.object({
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  // Optional explicit fields that must be preserved if provided
  constraints: z.array(z.string()).optional(),
  successCriteria: z.array(z.string()).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  riskLevel: z.enum(["read_only", "reversible", "sensitive"]).optional(),
  deadline: isoDateTimeSchema.optional(),
  budget: z.number().nonnegative().optional(),
  allowedCapabilities: z.array(z.string()).optional(),
  forbiddenCapabilities: z.array(z.string()).optional(),
  humanApprovalPolicy: z.enum(["never", "if_risky", "always"]).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  // CORE3 additions
  correlationId: z.string().optional(),
  policyContext: z.record(z.string(), z.string()).optional(),
}).strict();

export type HighLevelGoalInput = z.infer<typeof HighLevelGoalInputSchema>;

/**
 * Normalized high-level goal, ready for planning.
 */
export const HighLevelGoalSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  rawInput: z.string().trim().min(1),
  normalizedIntent: z.string().trim().min(1),
  constraints: z.array(z.string()).default([]),
  successCriteria: z.array(z.string()).default([]),
  priority: z.number().int().min(1).max(5).default(3),
  riskLevel: z.enum(["read_only", "reversible", "sensitive"]).default("reversible"),
  deadline: isoDateTimeSchema.optional(),
  budget: z.number().nonnegative().optional(),
  allowedCapabilities: z.array(z.string()).default([]),
  forbiddenCapabilities: z.array(z.string()).default([]),
  humanApprovalPolicy: z.enum(["never", "if_risky", "always"]).default("if_risky"),
  metadata: z.record(z.string(), z.string()).default({}),
  createdAt: isoDateTimeSchema,
  // CORE3 additions
  correlationId: z.string().optional(),
  policyContext: z.record(z.string(), z.string()).optional(),
}).strict();

export type HighLevelGoal = z.infer<typeof HighLevelGoalSchema>;

/**
 * Preview of a goal plan that can be turned into a mission.
 */
export const GoalPlanPreviewSchema = z.object({
  goalId: idSchema,
  missionTitle: z.string().trim().min(1),
  missionObjective: z.string().trim().min(1),
  tasks: z.array(
    z.object({
      id: idSchema,
      title: z.string().trim().min(1),
      description: z.string().optional().nullable(),
      dependsOn: z.array(idSchema).default([]),
      capability: z.string().optional().nullable(),
      workerKind: z.string().optional().nullable(),
      riskLevel: z.enum(["read_only", "reversible", "sensitive"]).default("reversible"),
      humanApprovalRequired: z.boolean().default(false),
      acceptanceCriteria: z.array(z.string()).default([]),
      // Worker requirements
      parallelizable: z.boolean().default(true),
      sandboxRequired: z.boolean().default(false),
      isolatedWorkspaceRequired: z.boolean().default(false),
    })
  ),
}).strict();

export type GoalPlanPreview = z.infer<typeof GoalPlanPreviewSchema>;