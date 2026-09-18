import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * An item of context that can be used by agents to make decisions.
 * Context items have a scope, type, and relevance metadata.
 */
export const contextItemSchema = z.object({
  id: idSchema,
  // The scope of this context item (e.g., mission, task, agent, global)
  scope: z.enum(["mission", "task", "agent", "global"]),
  // The type of context (e.g., text, data, artifact, decision, etc.)
  type: z.string(),
  // A summary or reference to the actual content.
  // For large content, we might store a reference (e.g., a path or ID) and fetch it later.
  summary: z.string(),
  // Optional: a reference to the actual content (e.g., an artifact ID, a URL, etc.)
  contentReference: z.string().optional(),
  // When this context item was created
  createdAt: isoDateTimeSchema,
  // When it was last updated (if applicable)
  updatedAt: isoDateTimeSchema.optional(),
  // Relevance metadata: priority, expiration, tags, etc.
  priority: z.number().int().min(0).max(100).optional(), // 0-100, higher is more important
  expiresAt: isoDateTimeSchema.optional(),
  tags: z.array(z.string()).optional(),
  // Estimated token count for LLMs (if applicable)
  tokenEstimate: z.number().int().nonnegative().optional(),
  // The mission ID this context item belongs to (if scope is mission)
  missionId: z.string(),
});

export type ContextItem = z.infer<typeof contextItemSchema>;
