import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";

// ─────────────────────────────────────
// Tool Identity (used by ExecutionGrant)
// ─────────────────────────────────────

/**
 * Format canonique : tool.<tenant>.<name>
 */
export const toolIdSchema = z
  .string()
  .min(3)
  .regex(/^tool\.[a-z0-9_-]+\.[a-z0-9_-]+$/, "format: tool.<tenant>.<name>");

export type ToolId = z.infer<typeof toolIdSchema>;

// ─────────────────────────────────────
// Request Hash — immutable invocation identity
// ─────────────────────────────────────

/**
 * Hash SHA-256 couvrant les dimensions immuables de l'invocation :
 * tenant, principal, toolId, toolDefinitionHash, version, operation,
 * resource, canonical arguments, capability, external-effect scope.
 *
 * Lié dans IdempotencyState, ExecutionGrant et ExecutionRecord.
 * Une future ApprovalResolution sera liée au même requestHash.
 */
export const requestHashSchema = z.string().min(1);

export type RequestHash = z.infer<typeof requestHashSchema>;

// ─────────────────────────────────────
// Execution Grant — single-use auth token
// ─────────────────────────────────────

export const executionGrantStatusSchema = z.enum(["issued", "consumed", "expired"]);

export type ExecutionGrantStatus = z.infer<typeof executionGrantStatusSchema>;

export const executionGrantSchema = z.object({
  id: idSchema,
  tenantId: z.string().min(1),
  principalId: z.string().min(1),
  missionId: z.string().min(1),
  runId: z.string().min(1),
  toolId: toolIdSchema,
  toolDefinitionHash: z.string().min(1),
  toolVersion: z.string().min(1),
  capability: z.string().min(1),
  operation: z.string().min(1),
  resource: z.string().min(1),
  requestHash: requestHashSchema,
  idempotencyKey: z.string().min(1),
  status: executionGrantStatusSchema.default("issued"),
  policyProvenance: z.object({
    policyVersion: z.string().min(1),
    attestedAt: isoDateTimeSchema,
    gatesPassed: z.array(z.string()).default([]),
  }),
  credentialRequirements: z.array(z.string()).default([]),
  networkRequired: z.boolean().default(false),
  isolationLevel: z.enum(["none", "process", "container", "sandbox"]).default("none"),
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

export type ExecutionGrant = z.infer<typeof executionGrantSchema>;

// ─────────────────────────────────────
// Idempotency State Machine
// ─────────────────────────────────────

/**
 * Cycle de vie de l'idempotence :
 *
 * RESERVED → EXECUTING → COMPLETED
 *                         FAILED_SAFE
 *                         UNKNOWN
 *
 * Stale EXECUTING → UNKNOWN (timeout/recovery)
 * UNKNOWN → jamais automatique, MANUAL_INTERVENTION_REQUIRED
 * FAILED_SAFE → RESERVED (retry autorisé)
 */
export const idempotencyStateSchema = z.enum([
  "RESERVED",
  "EXECUTING",
  "COMPLETED",
  "FAILED_SAFE",
  "UNKNOWN",
]);

export type IdempotencyState = z.infer<typeof idempotencyStateSchema>;

/** États terminaux : aucune transition automatique sortante. */
export const IDEMPOTENCY_TERMINAL: readonly IdempotencyState[] = [
  "COMPLETED",
  "UNKNOWN",
];

/** États depuis lesquels un retry est possible. */
export const IDEMPOTENCY_RETRYABLE: readonly IdempotencyState[] = [
  "FAILED_SAFE",
];

/** Vrai si une transition est atomiquement valide. */
export function isIdempotencyTransitionAllowed(
  from: IdempotencyState,
  to: IdempotencyState,
): boolean {
  switch (from) {
    case "RESERVED":
      return to === "EXECUTING" || to === "FAILED_SAFE" || to === "UNKNOWN";
    case "EXECUTING":
      return to === "COMPLETED" || to === "FAILED_SAFE" || to === "UNKNOWN";
    case "COMPLETED":
      return false; // terminal
    case "FAILED_SAFE":
      return to === "RESERVED"; // retry
    case "UNKNOWN":
      return false; // terminal until manual intervention
  }
}

// ─────────────────────────────────────
// Execution Attempt
// ─────────────────────────────────────

export const executionAttemptSchema = z.object({
  attemptNumber: z.number().int().positive(),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
  status: z.enum(["executing", "succeeded", "failed"]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
});

export type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;

// ─────────────────────────────────────
// Execution Record — immutable append-only history
// ─────────────────────────────────────

export const executionRecordSchema = z.object({
  id: idSchema,
  idempotencyKey: z.string().min(1),
  grantId: idSchema,
  tenantId: z.string().min(1),
  missionId: z.string().min(1),
  runId: z.string().min(1),
  toolId: toolIdSchema,
  requestHash: requestHashSchema,
  state: idempotencyStateSchema,
  attempts: z.array(executionAttemptSchema).default([]),
  output: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

// ─────────────────────────────────────
// Execution Record (audit-optimized, data-minimized)
// ─────────────────────────────────────

/**
 * Version allégée de l'ExecutionRecord pour les entrées d'audit.
 * Ne contient jamais de credentials, de corps bruts ou d'outputs volumineux.
 */
export const executionAuditPayloadSchema = z.object({
  grantId: idSchema,
  requestHash: requestHashSchema,
  tenantId: z.string().min(1),
  missionId: z.string().min(1),
  toolId: toolIdSchema,
  operation: z.string().min(1),
  resource: z.string().min(1),
  state: idempotencyStateSchema,
  outcome: z.string().optional(),
  errorCode: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  classification: z.string().optional(),
});

export type ExecutionAuditPayload = z.infer<typeof executionAuditPayloadSchema>;

// ─────────────────────────────────────
// Command types
// ─────────────────────────────────────

export interface IssueGrantInput {
  tenantId: string;
  principalId: string;
  missionId: string;
  runId: string;
  toolId: string;
  toolDefinitionHash: string;
  toolVersion: string;
  capability: string;
  operation: string;
  resource: string;
  requestHash: string;
  idempotencyKey: string;
  policyVersion: string;
  gatesPassed: readonly string[];
  credentialRequirements?: readonly string[];
  networkRequired?: boolean;
  isolationLevel?: "none" | "process" | "container" | "sandbox";
  ttlMs: number;
}

export interface ReserveExecutionInput {
  idempotencyKey: string;
  grantId: string;
  tenantId: string;
  missionId: string;
  runId: string;
  toolId: string;
  requestHash: string;
  input: unknown;
}

export interface CompleteExecutionInput {
  idempotencyKey: string;
  state: Exclude<IdempotencyState, "RESERVED">;
  output?: unknown;
  error?: { code: string; message: string };
  attemptNumber: number;
  durationMs: number;
}

/** Résultat de réservation atomique : soit réservé, soit déjà connu. */
export type ReservationResult =
  | { reserved: true; record: ExecutionRecord }
  | {
      reserved: false;
      existing: ExecutionRecord;
      conflict: "duplicate" | "idempotency_conflict" | "terminal";
    };

export type ConsumeGrantResult =
  | { consumed: true }
  | { consumed: false; reason: "already_consumed" | "expired" | "not_found" };
