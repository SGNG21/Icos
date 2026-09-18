import { z } from "zod";
import { idSchema } from "./common";

/**
 * Definition of a tool that can be used by agents.
 * This includes metadata about the tool, its input/output contracts, and allowed usage.
 */
export const toolDefinitionSchema = z.object({
  id: idSchema,
  // Human-readable name
  name: z.string().min(1),
  // Description of what the tool does
  description: z.string().optional(),
  // The category or type of tool (e.g., "filesystem", "web-search", "browser", "git", etc.)
  category: z.string(),
  // The input contract (Zod schema) as a JSON string (or we could reference a separate schema file)
  // For simplicity, we store it as a JSON string representing the Zod schema.
  inputContract: z.string(),
  // The output contract (Zod schema) as a JSON string
  outputContract: z.string(),
  // Whether the tool is allowed to be used in autonomous mode (without approval)
  isAutonomousAllowed: z.boolean().default(false),
  // Whether the tool requires approval before use
  requiresApproval: z.boolean().default(false),
  // Any constraints on usage (e.g., rate limits, allowed domains)
  constraints: z.record(z.string(), z.unknown()).optional(),
  // When this tool definition was created/updated
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
