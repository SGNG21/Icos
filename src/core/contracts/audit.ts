import { z } from "zod";

import { idSchema, isoDateTimeSchema, jsonValueSchema } from "./common";

export const auditEventTypeSchema = z.enum([
  "task.created",
  "task.transitioned",
  "approval.recorded",
  "action.decided",
]);

export const auditActorSchema = z.object({
  kind: z.enum(["agent", "human", "system"]),
  id: z.string().min(1),
});

/**
 * Entrée du journal d'audit. `details` doit rester sérialisable (JSON pur) et
 * ne jamais contenir de secret, de fonction ni d'objet de classe.
 */
export const auditEntrySchema = z.object({
  id: idSchema,
  occurredAt: isoDateTimeSchema,
  eventType: auditEventTypeSchema,
  actor: auditActorSchema,
  taskId: idSchema.optional(),
  actionId: idSchema.optional(),
  details: z.record(z.string(), jsonValueSchema),
});

export type AuditEventType = z.infer<typeof auditEventTypeSchema>;
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
