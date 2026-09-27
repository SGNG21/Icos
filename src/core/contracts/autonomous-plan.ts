import { z } from "zod";
import { idSchema } from "./common";
import { HighLevelGoalSchema } from "./high-level-goal";

/**
 * Autonomous plan produced by the planner.
 * Represents a deterministic, durable plan for achieving a high-level goal.
 */
export const autonomousPlanSchema = z.object({
  id: idSchema,
  missionId: z.string(),
  goalId: z.string(),
  /** Identity of ONE persisted plan version. Never equal to planFingerprint. */
  planId: z.string(),
  /**
   * Deterministic hash of canonical logical plan content.
   * Idempotency detection only — never an identity.
   */
  planFingerprint: z.string(),
  version: z.number().int().positive(),
  /**
   * Lineage pointer to the superseded version's planId (not its surrogate id).
   * Null on the first version of a mission's plan chain.
   */
  predecessorPlanId: z.string().nullish(),
  // Optional: createdAt, updatedAt if needed
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

/**
 * Planned task within an autonomous plan.
 * Represents a task that will be materialized into a canonical Task.
 */
export const plannedTaskSchema = z.object({
  id: idSchema,
  autonomousPlanId: idSchema,
  // Inherited from plan/mission/goal
  missionId: z.string(),
  goalId: z.string(),
  planId: z.string(),
  // Task-specific fields (from taskSchema without mission/goal/plan ids)
  title: z.string(),
  objective: z.string().optional(),
  instructions: z.string().optional(),
  // ... other task fields as needed, but keep minimal for planning
  // The actual task will be created via prepareTaskCreation which merges with taskSchema
});

export type AutonomousPlan = z.infer<typeof autonomousPlanSchema>;
export type PlannedTask = z.infer<typeof plannedTaskSchema>;