import { z } from "zod";

import { idSchema, isoDateTimeSchema, jsonValueSchema } from "./common";

export const auditEventTypeSchema = z.enum([
  "task.created",
  "task.transitioned",
  "approval.recorded",
  "action.decided",
  // Identité & sécurité (Lots 2B-1a et 2B-1b).
  "user.created",
  "role.changed",
  "auth.bootstrap.succeeded",
  "auth.bootstrap.failed",
  "auth.login.succeeded",
  "auth.login.rejected",
  "auth.logout.succeeded",
  "auth.access.denied",
  "human_user.created",
  "human_user.role_changed",
  "human_user.enabled",
  "human_user.disabled",
  "human_agent_link.created",
  "human_agent_link.removed",
  "human_user.administration_denied",
  // Capability registry (Lot C1).
  "capability.created",
  "capability.updated",
  "capability.status_changed",
  "agent_capability.granted",
  "agent_capability.revoked",
  // Skill registry (Lot C2).
  "skill.created",
  "skill.imported",
  "skill.content_changed",
  "skill.trust_changed",
  "skill.activation_changed",
  "skill.security_scan_recorded",
  "skill.eval_recorded",
  // D2 — Durable Orchestration.
  "mission.created",
  "mission.transitioned",
  "mission.plan_set",
  // G1 — Tool Gateway / Execution.
  "tool.invocation_reserved",
  "tool.invocation_started",
  "tool.invocation_completed",
  "tool.invocation_failed",
  "tool.invocation_unknown",
  "tool.grant_issued",
  "tool.grant_consumed",
  "tool.grant_expired",
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
