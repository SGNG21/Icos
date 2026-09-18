import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * An invocation of a tool by an agent or the system.
 * This records the input, output, and any errors.
 */
export const toolCallSchema = z.object({
  id: idSchema,
  // The tool definition that was invoked
  toolId: z.string(),
  // The agent or system that invoked the tool (optional)
  invokedBy: z.string().optional(), // Could be an agent ID or "system"
  // The input provided to the tool (should conform to the tool's input contract)
  input: z.string().optional(), // JSON string of the input
  // The output produced by the tool (should conform to the tool's output contract)
  output: z.string().optional(), // JSON string of the output
  // Any error that occurred during the tool invocation
  error: z
    .object({
      code: z.string(),
      message: z.string().max(2000),
    })
    .optional(),
  // Start and end timestamps
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.optional(),
  // Metrics (e.g., duration, cost, resource usage)
  metrics: z.record(z.string(), z.unknown()).optional(),
  // Recorded when this call was logged
  recordedAt: isoDateTimeSchema,
});

export type ToolCall = z.infer<typeof toolCallSchema>;
