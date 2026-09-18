import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * A decision made by the policy engine.
 * This determines whether an action is allowed, denied, or requires approval.
 */
export const policyDecisionSchema = z.object({
  id: idSchema,
  // The action or set of actions that the decision applies to
  actionIds: z.array(idSchema),
  // The mission and task context (optional)
  missionId: z.string().optional(),
  taskId: z.string().optional(),
  // The decision: allow, deny, or require_approval
  decision: z.enum(["allow", "deny", "require_approval"]),
  // The reason for the decision
  reason: z.string(),
  // Optional: any additional details (e.g., which policy rule matched)
  details: z.string().optional(),
  // The timestamp when the decision was made
  decidedAt: isoDateTimeSchema,
  // The policy version or rule ID that led to this decision
  policyRuleId: z.string().optional(),
});

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
