import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * A request for human approval on an action or set of actions.
 * This is created by the system when an action requires approval.
 * A human can then approve or reject the request.
 */
export const approvalRequestSchema = z.object({
  id: idSchema,
  // The action or set of actions that require approval.
  // We can reference an action by ID, or a set of action IDs.
  actionIds: z.array(idSchema),
  // The mission and task associated with this request (for context)
  missionId: z.string().optional(),
  taskId: z.string().optional(),
  // A description of why approval is needed.
  reason: z.string(),
  // Optional: any additional information to help the human decide.
  details: z.string().optional(),
  // The timestamp when the request was created
  requestedAt: isoDateTimeSchema,
  // Optional: a deadline for the approval
  deadlineAt: isoDateTimeSchema.optional(),
  // The current status of the request
  status: z.enum(["pending", "approved", "rejected", "expired"]).default("pending"),
  // If approved or rejected, the decision and who decided
  decision: z.enum(["approved", "rejected"]).optional(),
  decidedBy: z.string().optional(), // Label of the decidor (not authenticated)
  decidedAt: isoDateTimeSchema.optional(),
});

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
