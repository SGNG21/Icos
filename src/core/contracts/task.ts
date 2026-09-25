import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";
import { dependencyTypeSchema } from "./task-dependency";
import { HighLevelGoalSchema } from "./high-level-goal";

/**
 * Statut d'une tâche (distinct du statut d'exécution d'une action).
 * `succeeded`, `failed` et `cancelled` sont terminaux : aucune transition
 * ne permet de revenir vers un état actif.
 */
export const taskStatusSchema = z.enum([
  "draft",
  "queued",
  "awaiting_approval",
  "running",
  "review_pending",
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Risk class for a task (same as goal risk level).
 */
export const riskClassSchema = z.enum(["read_only", "reversible", "sensitive"]);

/**
 * Review policy for a task.
 */
export const reviewPolicySchema = z.enum(["never", "if_risky", "always"]);

/**
 * Integration policy for a task (free-form description).
 */
export const integrationPolicySchema = z.string();

/**
 * Base task without CORE3 planning fields (for legacy compatibility).
 */
export const baseTaskSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  assignedAgentId: idSchema.optional(),
  status: taskStatusSchema,
  actionIds: z.array(idSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * Generic Task (legacy compatible) - CORE3 fields are optional.
 */
export const taskSchema = baseTaskSchema.extend({
  // CORE3 fields (optional for legacy compatibility)
  missionId: z.string().optional(),
  goalId: z.string().optional(),
  planId: z.string().optional(),
  objective: z.string().optional(),
  instructions: z.string().optional(),
  dependencies: z.array(z.object({
    taskId: idSchema,
    type: dependencyTypeSchema,
  })).optional().default([]),
  successCriteria: z.array(z.string()).optional().default([]),
  requiredCapabilities: z.array(z.string()).optional().default([]),
  riskClass: riskClassSchema.default("reversible").optional(),
  allowedFileScope: z.array(z.string()).optional().default([]),
  expectedArtifacts: z.array(z.string()).optional().default([]),
  priority: z.number().int().min(1).max(5).default(3).optional(),
  attemptBudget: z.number().int().min(1).default(3).optional(),
  reviewPolicy: reviewPolicySchema.default("if_risky").optional(),
  integrationPolicy: integrationPolicySchema.default("").optional(),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type Task = z.infer<typeof taskSchema>;

/**
 * Autonomous Task Specification (CORE3 planning metadata) - strict.
 * Used internally by the planner to define how a canonical Task should be created/executed.
 */
export const autonomousTaskSpecSchema = baseTaskSchema.extend({
  // CORE3 fields (required for autonomous planning)
  missionId: z.string(),
  goalId: z.string(),
  planId: z.string(),
  objective: z.string(),
  instructions: z.string(),
  dependencies: z.array(z.object({
    taskId: idSchema,
    type: dependencyTypeSchema,
  })).default([]),
  successCriteria: z.array(z.string()).default([]),
  requiredCapabilities: z.array(z.string()).default([]),
  riskClass: riskClassSchema,
  allowedFileScope: z.array(z.string()).default([]),
  expectedArtifacts: z.array(z.string()).default([]),
  priority: z.number().int().min(1).max(5),
  attemptBudget: z.number().int().min(1),
  reviewPolicy: reviewPolicySchema,
  integrationPolicy: integrationPolicySchema,
});

export type AutonomousTaskSpec = z.infer<typeof autonomousTaskSpecSchema>;