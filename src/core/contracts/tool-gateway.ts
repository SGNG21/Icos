import { z } from "zod";

/**
 * The ToolGateway is responsible for invoking tools in a controlled and secure manner.
 * It receives a tool call request, checks policies, authorizes the invocation,
 * and then executes the tool via the appropriate adapter.
 *
 * Note: This is a conceptual contract. The actual implementation will be in src/server/tool/ or similar.
 */

/**
 * Request to invoke a tool.
 */
export const toolGatewayRequestSchema = z.object({
  // The ID of the tool definition to invoke
  toolId: z.string(),
  // The input for the tool (should conform to the tool's input contract)
  input: z.string(), // JSON string
  // Optional: the context of the invocation (mission, task, agent, etc.)
  context: z
    .object({
      missionId: z.string().optional(),
      taskId: z.string().optional(),
      agentId: z.string().optional(),
    })
    .optional(),
});

/**
 * Response from invoking a tool.
 */
export const toolGatewayResponseSchema = z.object({
  // Whether the invocation was successful
  success: z.boolean(),
  // The output of the tool (if successful)
  output: z.string().optional(), // JSON string
  // Error details (if not successful)
  error: z
    .object({
      code: z.string(),
      message: z.string().max(2000),
    })
    .optional(),
  // Any additional metadata (e.g., execution time, cost)
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ToolGatewayRequest = z.infer<typeof toolGatewayRequestSchema>;
export type ToolGatewayResponse = z.infer<typeof toolGatewayResponseSchema>;
