import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Statut d'une tâche (distinct du statut d'exécution d'une action).
 * `succeeded`, `failed` et `cancelled` sont terminaux : aucune transition
 * ne permet de revenir vers un état actif.
 */
export const taskStatusSchema = z.enum([
  "draft",
  "queued",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const taskSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  assignedAgentId: idSchema.optional(),
  status: taskStatusSchema,
  actionIds: z.array(idSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type Task = z.infer<typeof taskSchema>;
