import { z } from "zod";

import { idSchema } from "@/core/contracts";
import { humanAgentRelationSchema, roleSchema, userStatusSchema } from "@/core/identity";

export const createHumanBodySchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(12),
    name: z.string().trim().min(1).optional(),
    role: roleSchema,
  })
  .strict();

export const replaceRoleBodySchema = z.object({ role: roleSchema }).strict();

export const setStatusBodySchema = z.object({ status: userStatusSchema }).strict();

export const createAgentLinkBodySchema = z
  .object({ agentId: idSchema, relation: humanAgentRelationSchema })
  .strict();
