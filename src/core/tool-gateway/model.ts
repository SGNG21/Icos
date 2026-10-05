import { z } from "zod";

import {
  idSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  type JsonValue,
} from "@/core/contracts/common";

/**
 * Canonical Tool Gateway model (decision 0058). Pure data: no IO, no secret.
 *
 * Chain: ToolIntent (model-facing) → ToolRequest (gateway-built, trusted context)
 * → policy decision → [ToolApprovalRequest] → ToolExecution (durable evidence)
 * → Connector → ToolResult.
 *
 * Models and agents REQUEST tools. Permission, tenant and approval are decided
 * by the gateway from server-side state, never from anything the model sends.
 */

// ── Action classes (Phase 2) ──────────────────────────────────────────────────
// Each is an independent permission: no class implies another.
export const actionClassSchema = z.enum([
  "READ",
  "SEARCH",
  "CREATE",
  "WRITE",
  "UPDATE",
  "SEND",
  "PUBLISH",
  "DEPLOY",
  "DELETE",
  "EXECUTE",
  "PURCHASE",
  "PAY",
  "GRANT_ACCESS",
  "REVOKE_ACCESS",
  "CONFIGURE",
  "MERGE",
]);
export type ActionClass = z.infer<typeof actionClassSchema>;

// ── Risk (Phase 3) ────────────────────────────────────────────────────────────
export const riskClassSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskClass = z.infer<typeof riskClassSchema>;
export const RISK_ORDER: Readonly<Record<RiskClass, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// ── Connectors (Phase 5, 7) ───────────────────────────────────────────────────
export const connectorCategorySchema = z.enum([
  "EMAIL",
  "CALENDAR",
  "FILES",
  "GITHUB",
  "BROWSER",
  "TERMINAL",
  "CRM",
  "INVOICING",
  "TELEPHONY",
  "ANALYTICS",
  "SOCIAL",
  "MCP",
  "HTTP",
  "WEB",
  "SEARCH",
]);
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>;

export const connectorStatusSchema = z.enum([
  "REGISTERED",
  "CONFIGURED",
  "HEALTHY",
  "DEGRADED",
  "RATE_LIMITED",
  "AUTH_FAILED",
  "DISABLED",
  "UNKNOWN",
]);
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

/** Statuses under which the gateway will dispatch. Everything else fails closed. */
export const DISPATCHABLE_STATUSES: ReadonlySet<ConnectorStatus> = new Set([
  "CONFIGURED",
  "HEALTHY",
  "DEGRADED",
]);

// ── Failure classes (Phase 10) ────────────────────────────────────────────────
export const toolFailureClassSchema = z.enum([
  "AUTH_FAILURE",
  "PERMISSION_DENIED",
  "RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "NETWORK_ERROR",
  "TIMEOUT",
  "INVALID_INPUT",
  "CONFLICT",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "SETTLEMENT_UNKNOWN",
  "NOT_CONNECTED",
  "DUPLICATE_OPERATION",
  "UNKNOWN",
]);
export type ToolFailureClass = z.infer<typeof toolFailureClassSchema>;

/**
 * Whether the SAME request may be retried later. Exhaustive record, so adding a
 * class forces a deliberate answer. A retry never bypasses idempotency: the
 * gateway still refuses to re-dispatch anything whose settlement is not known.
 */
export const TOOL_FAILURE_RETRYABLE: Readonly<Record<ToolFailureClass, boolean>> = {
  AUTH_FAILURE: false,
  PERMISSION_DENIED: false,
  RATE_LIMIT: true,
  PROVIDER_UNAVAILABLE: true,
  NETWORK_ERROR: true,
  TIMEOUT: true,
  INVALID_INPUT: false,
  CONFLICT: false,
  NOT_FOUND: false,
  IDEMPOTENCY_CONFLICT: false,
  POLICY_DENIED: false,
  APPROVAL_REQUIRED: false,
  APPROVAL_REJECTED: false,
  APPROVAL_EXPIRED: false,
  SETTLEMENT_UNKNOWN: false,
  NOT_CONNECTED: false,
  DUPLICATE_OPERATION: false,
  UNKNOWN: false,
};

// ── Side effects / idempotency (Phase 4) ──────────────────────────────────────
export const sideEffectsSchema = z.enum(["none", "internal", "external"]);

/**
 * - `natural`: repeating the call is harmless (reads, PUT-by-id).
 * - `key_required`: the caller MUST supply an idempotencyKey; a duplicate key
 *   never re-dispatches. Mandatory for any external side effect.
 */
export const idempotencySemanticsSchema = z.enum(["natural", "key_required"]);

/**
 * Settlement of a side effect at the provider:
 * - NOT_STARTED: never dispatched;
 * - DISPATCHED: handed to the provider, outcome not yet known (in flight);
 * - APPLIED: provider confirmed the effect;
 * - NOT_APPLIED: provider confirmed nothing happened (safe to retry);
 * - UNKNOWN: outcome cannot be established → never re-dispatched, reconcile only.
 */
export const settlementStateSchema = z.enum([
  "NOT_STARTED",
  "DISPATCHED",
  "APPLIED",
  "NOT_APPLIED",
  "UNKNOWN",
]);
export type SettlementState = z.infer<typeof settlementStateSchema>;

// ── Approval (Phase 3) ────────────────────────────────────────────────────────
export const approvalRequirementSchema = z
  .object({
    /**
     * `human`: only a human with `approvals.decide`. `human_or_agent`: another agent may also.
     * HIGH and CRITICAL are always forced to `human` (kernel rule: `sensitive` needs a human).
     */
    mode: z.enum(["none", "human", "human_or_agent"]),
    /** Requester may approve its own request (agent approvers only; MEDIUM or LOW). */
    selfApprovalAllowed: z.boolean().default(false),
    /** How long a granted approval stays usable. */
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 3600)
      .default(3600),
  })
  .strict();
export type ApprovalRequirement = z.infer<typeof approvalRequirementSchema>;

// ── Duplicate operations (same meaningful operation, different idempotency key) ──
/**
 * - `allow`: repeating the operation is legitimate (reads, drafts…);
 * - `block`: a second identical operation inside the window is refused;
 * - `require_override`: refused unless the caller names the prior execution it
 *   knowingly repeats (`duplicateOverride`), which is then recorded as evidence.
 */
export const duplicatePolicySchema = z
  .object({
    mode: z.enum(["allow", "block", "require_override"]),
    windowSeconds: z
      .number()
      .int()
      .nonnegative()
      .max(90 * 24 * 3600),
  })
  .strict();
export type DuplicatePolicy = z.infer<typeof duplicatePolicySchema>;

/** Action classes whose repetition is a distinct, usually unwanted, real-world effect. */
export const RETRY_SENSITIVE_ACTIONS: ReadonlySet<ActionClass> = new Set([
  "SEND",
  "PUBLISH",
  "DEPLOY",
  "DELETE",
  "PURCHASE",
  "PAY",
  "GRANT_ACCESS",
  "REVOKE_ACCESS",
]);

// ── Tool definition (Phase 1) ─────────────────────────────────────────────────
/** Permission key for one action of one tool. Exact match only — no wildcard, no hierarchy. */
export const toolPermissionKey = (toolId: string, action: ActionClass) => `${toolId}:${action}`;

export const credentialRequirementSchema = z
  .object({ kind: z.string().min(1), required: z.boolean() })
  .strict();

export const toolActionDefinitionSchema = z
  .object({
    action: actionClassSchema,
    description: z.string().min(1),
    risk: riskClassSchema,
    sideEffects: sideEffectsSchema,
    idempotency: idempotencySemanticsSchema,
    /** Reconcile by idempotencyKey / providerOperationId after a crash is supported. */
    reconcilable: z.boolean().default(false),
    /** Omitted → retry-sensitive classes default to `require_override` over 24 h (see policy). */
    duplicatePolicy: duplicatePolicySchema.optional(),
    approval: approvalRequirementSchema,
    /** JSON Schema of the input / output (machine-readable, model-safe). */
    inputSchema: z.record(z.string(), jsonValueSchema),
    outputSchema: z.record(z.string(), jsonValueSchema),
  })
  .strict()
  .superRefine((a, ctx) => {
    // Any effect must not duplicate on retry; approved requests are matched on retry by key.
    const needsKey =
      a.sideEffects !== "none" ||
      a.approval.mode !== "none" ||
      RISK_ORDER[a.risk] >= RISK_ORDER.HIGH;
    if (needsKey && a.idempotency !== "key_required") {
      ctx.addIssue({
        code: "custom",
        path: ["idempotency"],
        message: "side-effecting, approval-gated or HIGH+ actions require key_required idempotency",
      });
    }
  });
export type ToolActionDefinition = z.infer<typeof toolActionDefinitionSchema>;

export const toolDefinitionSchema = z
  .object({
    toolId: idSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    category: connectorCategorySchema,
    description: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
    actions: z.array(toolActionDefinitionSchema).min(1),
    credential: credentialRequirementSchema.optional(),
    rateLimit: z
      .object({ maxRequests: z.number().int().positive(), perSeconds: z.number().int().positive() })
      .strict()
      .optional(),
    timeoutMs: z.number().int().positive().max(600_000),
    /** What the evidence keeps: never the raw provider payload unless explicitly `summary`. */
    auditPolicy: z.object({ persistResult: z.enum(["none", "summary"]) }).strict(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    for (const a of t.actions) {
      if (seen.has(a.action)) {
        ctx.addIssue({
          code: "custom",
          path: ["actions"],
          message: `duplicate action ${a.action}`,
        });
      }
      seen.add(a.action);
    }
  });
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const findAction = (tool: ToolDefinition, action: ActionClass) =>
  tool.actions.find((a) => a.action === action);

// ── Connector definition / instance (Phase 5) ────────────────────────────────
export const connectorDefinitionSchema = z
  .object({
    connectorId: idSchema,
    category: connectorCategorySchema,
    /** `NOT_CONNECTED`: contract only, no real integration exists in this repository. */
    availability: z.enum(["CONNECTED", "NOT_CONNECTED"]),
    tools: z.array(toolDefinitionSchema).min(1),
    supportsCancel: z.boolean(),
    supportsReconcile: z.boolean(),
  })
  .strict();
export type ConnectorDefinition = z.infer<typeof connectorDefinitionSchema>;

/** Opaque handle to a secret held by a resolver. Never the secret itself. */
export const credentialReferenceSchema = z
  .object({
    ref: z.string().regex(/^cred_[a-z0-9_-]{3,}$/),
    tenantId: z.string().min(1),
    kind: z.string().min(1),
  })
  .strict();
export type CredentialReference = z.infer<typeof credentialReferenceSchema>;

export const connectorInstanceSchema = z
  .object({
    instanceId: idSchema,
    connectorId: idSchema,
    /** A tenant (client) owns its instances: no cross-tenant use, ever. */
    tenantId: z.string().min(1),
    credential: credentialReferenceSchema.optional(),
    /** Non-secret configuration only (base URL, root directory…). */
    config: z.record(z.string(), jsonValueSchema),
    /** Administrative switch. Live health is NOT configuration: it comes from dated probes. */
    enabled: z.boolean(),
  })
  .strict();
export type ConnectorInstance = z.infer<typeof connectorInstanceSchema>;

// ── Model-facing intent (Phase 11) ───────────────────────────────────────────
/**
 * What a model/agent may send. Strict: no tenant, no principal, no approval,
 * no credential field can be injected. The gateway adds all trusted context.
 */
export const toolIntentSchema = z
  .object({
    toolId: idSchema,
    action: actionClassSchema,
    connectorInstanceId: idSchema,
    input: z.record(z.string(), jsonValueSchema),
    /** Mandatory for `key_required` actions; stable across retries of the same intent. */
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{8,128}$/)
      .optional(),
    missionId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    /** Knowingly repeat the operation of a prior execution (duplicate policy `require_override`). */
    duplicateOverride: z
      .object({
        ofExecutionId: z.string().min(1).max(128),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ToolIntent = z.infer<typeof toolIntentSchema>;

/** Trusted caller context, resolved server-side (session, worker lease…), never by the model. */
export interface ToolCaller {
  tenantId: string;
  agentId: string;
}

// ── Execution evidence (Phase 9) ──────────────────────────────────────────────
export const toolExecutionStatusSchema = z.enum([
  "REQUESTED",
  "AWAITING_APPROVAL",
  "DENIED",
  "REJECTED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
]);
export type ToolExecutionStatus = z.infer<typeof toolExecutionStatusSchema>;

export const toolExecutionSchema = z
  .object({
    toolExecutionId: z.string().min(1),
    tenantId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    /** sha256(tenant, requester, tool, action, instance, input): binds key and approval. */
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** sha256(tenant, tool, action, instance, input): the operation, whoever asks. Duplicate detection. */
    operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** Set when this execution knowingly repeats a prior one (override recorded as evidence). */
    duplicateOf: z.string().max(128).optional(),
    toolId: z.string().min(1),
    toolVersion: z.string().min(1),
    action: actionClassSchema,
    connectorInstanceId: z.string().min(1),
    requesterAgentId: z.string().min(1),
    missionId: z.string().optional(),
    taskId: z.string().optional(),
    riskClass: riskClassSchema,
    sideEffects: sideEffectsSchema,
    status: toolExecutionStatusSchema,
    settlementState: settlementStateSchema,
    approvalRequestId: z.string().optional(),
    attemptCount: z.number().int().nonnegative(),
    providerOperationId: z.string().max(256).optional(),
    failureClass: toolFailureClassSchema.optional(),
    failureMessage: z.string().max(500).optional(),
    /** Bounded, secret-free summary; never the full third-party payload. */
    resultSummary: z.record(z.string(), jsonValueSchema).optional(),
    resultReference: z.string().max(512).optional(),
    /** Connector output is data from outside ICOS, never instructions. */
    resultTrust: z.literal("UNTRUSTED_EXTERNAL_DATA").optional(),
    auditReferences: z.array(z.string()),
    version: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.optional(),
    finishedAt: isoDateTimeSchema.optional(),
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .refine((e) => (e.status === "SUCCEEDED") === (e.settlementState === "APPLIED"), {
    message: "SUCCEEDED if and only if the side effect is APPLIED",
  });
export type ToolExecution = z.infer<typeof toolExecutionSchema>;

export const toolApprovalRequestSchema = z
  .object({
    approvalRequestId: z.string().min(1),
    tenantId: z.string().min(1),
    toolExecutionId: z.string().min(1),
    /** An approval is bound to one exact request: a changed input needs a new approval. */
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    requesterAgentId: z.string().min(1),
    toolId: z.string().min(1),
    action: actionClassSchema,
    riskClass: riskClassSchema,
    /** Exactly what will run (secret-screened, ≤ 8 KiB): the approver decides on this, not on a hash. */
    inputPreview: z.record(z.string(), jsonValueSchema),
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    decidedBy: z
      .object({ kind: z.enum(["human", "agent"]), id: z.string().min(1) })
      .strict()
      .optional(),
    reason: z.string().max(1000).optional(),
    /** Set when this approval covers a knowing repeat of a prior execution. */
    duplicateOf: z.string().max(128).optional(),
    /** Single use: set when the approved request is dispatched. */
    consumedAt: isoDateTimeSchema.optional(),
    requestedAt: isoDateTimeSchema,
    decidedAt: isoDateTimeSchema.optional(),
    /** Pending: deadline to decide. Approved: deadline to execute. Past it → APPROVAL_EXPIRED. */
    expiresAt: isoDateTimeSchema,
  })
  .strict();
export type ToolApprovalRequest = z.infer<typeof toolApprovalRequestSchema>;

/** Explicit grant of ONE action of ONE tool to ONE agent in ONE tenant. */
export const toolGrantSchema = z
  .object({
    tenantId: z.string().min(1),
    agentId: z.string().min(1),
    toolId: z.string().min(1),
    action: actionClassSchema,
    grantedBy: z.string().min(1),
    grantedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema.optional(),
    /** Why the grant exists (evidence), mandatory. */
    reason: z.string().trim().min(1).max(500),
    /** Revocation keeps the row: who, when and why stay inspectable. */
    revokedAt: isoDateTimeSchema.optional(),
    revokedBy: z.string().min(1).optional(),
    revokeReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type ToolGrant = z.infer<typeof toolGrantSchema>;

const OBJECT: Record<string, JsonValue> = { type: "object" };

/**
 * Compact action builder. Side effects decide idempotency: anything that
 * changes state, needs approval or is HIGH+ is `key_required`.
 */
export function act(
  action: ActionClass,
  risk: RiskClass,
  sideEffects: ToolActionDefinition["sideEffects"],
  description: string,
  more: Partial<
    Pick<ToolActionDefinition, "inputSchema" | "outputSchema" | "reconcilable" | "duplicatePolicy">
  > & {
    approval?: Partial<ApprovalRequirement>;
  } = {},
): ToolActionDefinition {
  const approvalMode =
    more.approval?.mode ?? (risk === "HIGH" || risk === "CRITICAL" ? "human" : "none");
  const keyed =
    sideEffects !== "none" || approvalMode !== "none" || risk === "HIGH" || risk === "CRITICAL";
  return {
    action,
    description,
    risk,
    sideEffects,
    idempotency: keyed ? "key_required" : "natural",
    reconcilable: more.reconcilable ?? false,
    ...(more.duplicatePolicy ? { duplicatePolicy: more.duplicatePolicy } : {}),
    approval: {
      selfApprovalAllowed: false,
      ttlSeconds: 3600,
      ...more.approval,
      mode: approvalMode,
    },
    inputSchema: more.inputSchema ?? OBJECT,
    outputSchema: more.outputSchema ?? OBJECT,
  };
}

// ── Connector health evidence (dated, expirable — decision 0033 applied to tools) ──
export const connectorHealthRecordSchema = z
  .object({
    tenantId: z.string().min(1),
    instanceId: z.string().min(1),
    /** Last PROBED status. Never assumed: no record → UNKNOWN. */
    status: connectorStatusSchema,
    checkedAt: isoDateTimeSchema,
    /** Past it the evidence is stale and the instance reads UNKNOWN. */
    expiresAt: isoDateTimeSchema,
    /** Provider throttling window (429), independent of the probed status. */
    rateLimitedUntil: isoDateTimeSchema.optional(),
    detail: z.string().max(200).optional(),
  })
  .strict();
export type ConnectorHealthRecord = z.infer<typeof connectorHealthRecordSchema>;
