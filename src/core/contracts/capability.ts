import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Statut d'une capacité (lifecycle). `retired` est terminal :
 * aucune transition ne permet de revenir vers un état actif.
 */
export const capabilityStatusSchema = z.enum([
  "proposed",
  "active",
  "deprecated",
  "retired",
]);

/**
 * Clé métier stable d'une capacité : segments de domaine séparés par `.`,
 * minuscules, chiffres, tirets ou underscores. Exemples : `code.review`,
 * `crm.read`.
 */
export const capabilityKeySchema = z
  .string()
  .min(3)
  .regex(
    /^[a-z0-9][a-z0-9_-]+(\.[a-z0-9][a-z0-9_-]+)*$/,
    "key invalide (segments minuscules séparés par .)",
  );

export const capabilitySchema = z.object({
  id: idSchema,
  key: capabilityKeySchema,
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1),
  status: capabilityStatusSchema,
  provenance: z.record(z.string()).optional(),
  riskHint: z.string().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;
export type Capability = z.infer<typeof capabilitySchema>;

/**
 * Relation assignation capacité ↔ agent. Une ligne dans cette table ne
 * confère aucune autorisation d'exécution ; elle documente quelles
 * capacités sont reconnues à un agent.
 */
export const agentCapabilitySchema = z.object({
  id: idSchema,
  agentId: idSchema,
  capabilityId: idSchema,
  assignedAt: isoDateTimeSchema,
  assignedByUserId: idSchema,
});

export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
