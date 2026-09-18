import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";
import { executionErrorSchema } from "./task-execution";

/**
 * An attempt to execute a task. Each task may have multiple attempts.
 */
export const executionAttemptSchema = z.object({
  id: idSchema,
  taskId: z.string(),
  missionId: z.string(),
  // Reference to the workflow execution (if using a durable execution engine like Temporal)
  workflowId: z.string().optional(),
  // The agent that was assigned to perform this attempt
  agentId: z.string().optional(),
  // The tool or skill used (if any)
  toolId: z.string().optional(),
  skillId: z.string().optional(),
  // Start and end timestamps
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.optional(),
  // Outcome: success, failure, cancelled, timeout, etc.
  outcome: z.enum(["success", "failure", "cancelled", "timeout"]),
  // Error details if outcome is failure or timeout
  error: z
    .object({
      code: z.string(), // e.g., "WORKER_FAILED", "TIMEOUT", "TOOL_ERROR", etc.
      message: z.string().max(2000),
    })
    .optional(),
  // Any artifacts produced by this attempt
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
  // Metrics (e.g., duration, token count, cost)
  metrics: z.record(z.string(), z.unknown()).optional(),
  // Recorded when this attempt was logged
  recordedAt: isoDateTimeSchema,
});

export type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;
