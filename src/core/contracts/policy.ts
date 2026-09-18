import { z } from "zod";
import { idSchema } from "./common";

/**
 * A policy rule that the policy engine evaluates.
 * Policies are used to determine whether actions are allowed, denied, or require approval.
 */
export const policySchema = z.object({
  id: idSchema,
  // Human-readable name
  name: z.string().min(1),
  // Description of what this policy does
  description: z.string().optional(),
  // The category or type of policy (e.g., "security", "approval", "rate-limiting")
  category: z.string(),
  // The condition under which this policy applies (as a JSON string representing a Zod schema or a custom logic)
  // For simplicity, we store it as a JSON string that can be evaluated by the policy engine.
  condition: z.string(),
  // The action to take when the condition is met: "allow", "deny", or "require_approval"
  action: z.enum(["allow", "deny", "require_approval"]),
  // Priority: higher numbers are evaluated first (if multiple policies match)
  priority: z.number().int().default(0),
  // Whether this policy is currently enabled
  enabled: z.boolean().default(true),
  // When this policy was created/updated
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

export type Policy = z.infer<typeof policySchema>;
