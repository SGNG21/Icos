import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "../contracts/common";

export const humanAgentRelationSchema = z.enum(["supervisor", "operator", "observer"]);

export type HumanAgentRelation = z.infer<typeof humanAgentRelationSchema>;

export const humanAgentLinkSchema = z
  .object({
    id: idSchema,
    humanUserId: idSchema,
    agentId: idSchema,
    relation: humanAgentRelationSchema,
    createdAt: isoDateTimeSchema,
    createdByHumanUserId: idSchema,
  })
  .strict();

export type HumanAgentLink = z.infer<typeof humanAgentLinkSchema>;
