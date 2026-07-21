import { z } from "zod";

import { approvalStatusSchema, idSchema, taskStatusSchema } from "@/core/contracts";

/**
 * Corps de création de tâche. `.strict()` rejette tout champ superflu. Le titre
 * est normalisé (`trim`) avant contrôle de longueur : une chaîne uniquement
 * composée d'espaces est rejetée.
 */
export const createTaskBodySchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().optional(),
    assignedAgentId: idSchema.optional(),
  })
  .strict();

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

export const transitionBodySchema = z.object({ to: taskStatusSchema }).strict();
export type TransitionBody = z.infer<typeof transitionBodySchema>;

/** Filtre de requête pour la liste des actions. */
export const actionQuerySchema = z.object({
  approvalStatus: approvalStatusSchema.optional(),
});

/** Filtre de requête pour le journal d'audit. */
export const auditQuerySchema = z.object({
  eventType: z
    .enum(["task.created", "task.transitioned", "approval.recorded", "action.decided"])
    .optional(),
  actorId: z.string().min(1).optional(),
  taskId: idSchema.optional(),
  actionId: idSchema.optional(),
});
