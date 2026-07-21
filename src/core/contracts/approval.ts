import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Décision humaine traçable portant sur une action. La décision est portée par
 * un unique champ `decision` — aucune seconde propriété ne peut la contredire.
 */
export const approvalDecisionSchema = z.enum(["approved", "rejected"]);

export const approvalSchema = z.object({
  id: idSchema,
  actionId: idSchema,
  decidedBy: z.string().min(1),
  decision: approvalDecisionSchema,
  reason: z.string().optional(),
  decidedAt: isoDateTimeSchema,
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type Approval = z.infer<typeof approvalSchema>;
