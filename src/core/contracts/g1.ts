import { z } from "zod";

import { idSchema, isoDateTimeSchema, jsonValueSchema } from "./common";
import { sensitivityLevelSchema } from "./skill";

// ─────────────────────────────────────
// IdempotencyKey — identité métier stable
// ─────────────────────────────────────

/**
 * Clé d'idempotence : chaîne déterministe dérivée des invariants de
 * l'invocation (tenant, mission, tool, capability, operation, resource,
 * arguments canoniques).
 *
 * `AttemptNumber` est distinct de `IdempotencyKey` : un retry technique
 * conserve la même clé.
 */
export const idempotencyKeySchema = z.string().min(1);

export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

// ─────────────────────────────────────
// RequestHash — empreinte canonique
// ─────────────────────────────────────

/**
 * Empreinte SHA-256 de l'invocation canonique. Couvre les éléments
 * d'identité immuable : tenant, principal, toolId, toolDefinitionHash,
 * capability, operation, resource, arguments, external-effect scope.
 *
 * Toute divergence entre requestHash attendu et fourni : FAIL CLOSED.
 */
export const requestHashSchema = z.string().min(1);

export type RequestHash = z.infer<typeof requestHashSchema>;

// ─────────────────────────────────────
// IdempotencyState
// ─────────────────────────────────────

export const idempotencyStateStatusSchema = z.enum([
  "RESERVED",
  "EXECUTING",
  "COMPLETED",
  "FAILED_SAFE",
  "UNKNOWN",
]);

/**
 * État opérationnel mutable d'une exécution. Chaque transition est
 * atomique et auditable.
 *
 * `RESERVED` : D4 n'a PAS été appelé.
 * `EXECUTING` : l'exécution D4 est en cours (peut devenir stale).
 * `COMPLETED` : résultat durable et rejouable.
 * `FAILED_SAFE` : échec non récupérable, arrêt sûr.
 * `UNKNOWN` : stale EXECUTING sans réconciliation vérifiable.
 */
export const idempotencyStateSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  requestHash: requestHashSchema,
  state: idempotencyStateStatusSchema,
  attemptNumber: z.number().int().positive(),
  tenant: z.string().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  lockedAt: isoDateTimeSchema.optional(),
  lockedBy: z.string().optional(),
});

export type IdempotencyStateStatus = z.infer<typeof idempotencyStateStatusSchema>;
export type IdempotencyState = z.infer<typeof idempotencyStateSchema>;

// ─────────────────────────────────────
// ExecutionGrant — autorisation d'invocation
// ─────────────────────────────────────

/**
 * ExecutionGrant signifie : "cette invocation précise est actuellement
 * autorisée". Lié à l'identité complète de l'invocation : tenant,
 * principal, mission, run, outil, capability, operation, resource,
 * requestHash, idempotencyKey, provenance politique.
 *
 * Règles V1 :
 * - TTL court (expiresAt - issuedAt limité)
 * - Usage unique (consumed = true après consommation)
 */
export const executionGrantSchema = z.object({
  id: idSchema,
  tenant: z.string().min(1),
  principal: z.string().min(1),
  mission: z.string().min(1),
  run: z.string().min(1),
  toolId: z.string().min(1),
  toolDefinitionHash: z.string().min(1),
  toolVersion: z.string().optional(),
  capability: z.string().min(1),
  operation: z.string().min(1),
  resource: z.string().min(1),
  requestHash: requestHashSchema,
  idempotencyKey: idempotencyKeySchema,
  policyProvenance: z.record(z.string(), jsonValueSchema),
  credentialRequirements: z.record(z.string(), jsonValueSchema).optional(),
  networkRequirements: z.record(z.string(), jsonValueSchema).optional(),
  isolationRequirements: z.record(z.string(), jsonValueSchema).optional(),
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  consumed: z.boolean().default(false),
});

export type ExecutionGrant = z.infer<typeof executionGrantSchema>;

// ─────────────────────────────────────
// Tool Invocation Event Types
// ─────────────────────────────────────

export const toolInvocationEventTypeSchema = z.enum([
  "tool.invocation_reserved",
  "tool.invocation_started",
  "tool.invocation_completed",
  "tool.invocation_failed",
  "tool.invocation_unknown",
]);

export type ToolInvocationEventType = z.infer<typeof toolInvocationEventTypeSchema>;

// ─────────────────────────────────────
// ExecutionRecord — audit immuable
// ─────────────────────────────────────

/**
 * Enregistrement immuable d'un événement du cycle de vie d'une invocation.
 *
 * L'ExecutionRecord est append-only et garantit la data minimization :
 * aucun credential brut, secret, ou sortie brute arbitraire n'y est
 * persisté.
 */
export const executionRecordSchema = z.object({
  id: idSchema,
  idempotencyKey: idempotencyKeySchema,
  requestHash: requestHashSchema,
  grantId: idSchema,
  tenant: z.string().min(1),
  eventType: toolInvocationEventTypeSchema,
  actor: z.string().min(1),
  classification: sensitivityLevelSchema,
  occurredAt: isoDateTimeSchema,
  outcome: z.string().optional(),
  errorCode: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  artifactRefs: z.array(z.string()).optional(),
  outputHash: z.string().optional(),
  policyRefs: z.array(z.string()).optional(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

// ─────────────────────────────────────
// Grant consumption result
// ─────────────────────────────────────

/**
 * Résultat d'une tentative de consommation d'ExecutionGrant.
 */
export type ConsumeGrantResult =
  | { ok: true; grant: ExecutionGrant }
  | { ok: false; reason: "already_consumed" | "expired" | "not_found"; message: string };
