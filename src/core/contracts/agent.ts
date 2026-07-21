import { z } from "zod";

import { authorizationLevelSchema, idSchema } from "./common";

export const agentStatusSchema = z.enum(["available", "standby", "offline"]);

export const agentSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  role: z.string().min(1),
  status: agentStatusSchema,
  authorizationLevel: authorizationLevelSchema,
  description: z.string().min(1),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type Agent = z.infer<typeof agentSchema>;
