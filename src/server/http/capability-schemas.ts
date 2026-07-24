import { z } from "zod";

import { capabilityKeySchema, capabilityStatusSchema } from "@/core/contracts/capability";

export const createCapabilityBodySchema = z
  .object({
    key: capabilityKeySchema,
    name: z.string().min(1),
    description: z.string().optional(),
    category: z.string().min(1),
    provenance: z.record(z.string(), z.string()).optional(),
    riskHint: z.string().optional(),
  })
  .strict();

export const changeCapabilityStatusBodySchema = z
  .object({ status: capabilityStatusSchema })
  .strict();

export const grantCapabilityBodySchema = z.object({ capabilityId: z.string().min(1) }).strict();
