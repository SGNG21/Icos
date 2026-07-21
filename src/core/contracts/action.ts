import { z } from "zod";

import { approvalStatusSchema, idSchema, isoDateTimeSchema, riskLevelSchema } from "./common";

/**
 * Action initiée par un agent.
 *
 * `requiresHumanApproval` est une exigence SUPPLÉMENTAIRE, jamais une
 * permission de contournement : une action `sensitive` exige toujours une
 * approbation humaine explicite, même si ce champ vaut `false`. La politique
 * centrale (`src/core/authorization`) est prioritaire sur cette déclaration.
 */
export const agentActionSchema = z.object({
  id: idSchema,
  initiatedByAgentId: idSchema,
  kind: z.string().min(1),
  risk: riskLevelSchema,
  requiresHumanApproval: z.boolean(),
  approvalStatus: approvalStatusSchema,
  taskId: idSchema.optional(),
  requestedAt: isoDateTimeSchema,
});

export type AgentAction = z.infer<typeof agentActionSchema>;
