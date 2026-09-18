import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * A run of an agent on a task or mission.
 * This tracks the execution of an agent (which may use skills and tools).
 */
export const agentRunSchema = z.object({
  id: idSchema,
  // The agent definition (referring to an agent in the agent registry)
  agentId: z.string(),
  // The mission and task this run is associated with
  missionId: z.string().optional(),
  taskId: z.string().optional(),
  // The input provided to the agent (could be a reference to a context or a prompt)
  input: z.string().optional(),
  // The output produced by the agent
  output: z.string().optional(),
  // Start and end timestamps
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.optional(),
  // Status: running, succeeded, failed, cancelled
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  // Error details if failed
  error: z
    .object({
      code: z.string(),
      message: z.string().max(2000),
    })
    .optional(),
  // Metrics (e.g., token count, cost, duration)
  metrics: z.record(z.string(), z.unknown()).optional(),
  // Recorded when this run was logged
  recordedAt: isoDateTimeSchema,
});

export type AgentRun = z.infer<typeof agentRunSchema>;
