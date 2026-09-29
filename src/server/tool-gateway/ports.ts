import { inspect } from "node:util";

import type { AuditEntry, JsonValue } from "@/core/contracts";
import type {
  ActionClass,
  ConnectorDefinition,
  ConnectorInstance,
  ConnectorStatus,
  CredentialReference,
  SettlementState,
  ToolApprovalRequest,
  ToolExecution,
  ToolExecutionStatus,
  ToolFailureClass,
  ToolGrant,
} from "@/core/tool-gateway/model";

// ── Credential boundary (Phase 6) ─────────────────────────────────────────────

/**
 * A resolved secret. It only ever travels gateway → connector. Every
 * serialisation path (JSON, string, util.inspect/console) yields a redaction,
 * so an accidental log, prompt or DB write cannot carry the value.
 */
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "[REDACTED]";
  }
  toString(): string {
    return "[REDACTED]";
  }
  [inspect.custom](): string {
    return "[REDACTED]";
  }
}

export type CredentialResolution =
  | { ok: true; secret: SecretValue }
  | { ok: false; reason: "not_found" | "expired" | "tenant_mismatch" };

export interface CredentialResolver {
  resolve(ref: CredentialReference, tenantId: string): Promise<CredentialResolution>;
}

// ── Connector contract (Phase 5) ──────────────────────────────────────────────

export interface ConnectorContext {
  instance: ConnectorInstance;
  credential?: SecretValue;
  signal: AbortSignal;
  /** Forward to the provider when it supports idempotency (e.g. `Idempotency-Key`). */
  idempotencyKey: string;
  toolExecutionId: string;
}

export type ConnectorOutcome =
  | {
      ok: true;
      /** Returned to the caller only; never persisted. */
      output: Record<string, JsonValue>;
      /** Small, non-sensitive digest that the evidence may keep. */
      summary?: Record<string, JsonValue>;
      providerOperationId?: string;
      resultReference?: string;
    }
  | {
      ok: false;
      failureClass: ToolFailureClass;
      /** NOT_APPLIED only when the provider guarantees nothing happened. */
      settlement: "NOT_APPLIED" | "UNKNOWN";
      message: string;
      retryAfterSeconds?: number;
    };

export type ReconcileOutcome =
  | { settlement: "APPLIED"; providerOperationId?: string; summary?: Record<string, JsonValue> }
  | { settlement: "NOT_APPLIED" }
  | { settlement: "UNKNOWN" };

/** Provider-neutral adapter. No business rules here: permission, risk and approval live in the gateway. */
export interface Connector {
  readonly definition: ConnectorDefinition;
  health(
    ctx: Omit<ConnectorContext, "idempotencyKey" | "toolExecutionId">,
  ): Promise<ConnectorStatus>;
  execute(
    toolId: string,
    action: ActionClass,
    input: Record<string, JsonValue>,
    ctx: ConnectorContext,
  ): Promise<ConnectorOutcome>;
  /** Establish what happened to an in-flight side effect (after crash / timeout). */
  reconcile?(
    toolId: string,
    action: ActionClass,
    ref: { idempotencyKey: string; providerOperationId?: string },
    ctx: ConnectorContext,
  ): Promise<ReconcileOutcome>;
  cancel?(providerOperationId: string, ctx: ConnectorContext): Promise<boolean>;
}

// ── Durable stores (every method is tenant-scoped) ───────────────────────────

export interface ExecutionQuery {
  status?: readonly ToolExecutionStatus[];
  settlement?: readonly SettlementState[];
  limit?: number;
}

/**
 * Evidence store. Every write carries its audit entry and commits both
 * atomically: an execution state never exists without its audit record.
 */
export interface ToolExecutionStore {
  /** Insert unless (tenantId, idempotencyKey) exists; then return the existing row untouched. */
  claim(
    execution: ToolExecution,
    audit: AuditEntry,
  ): Promise<{ created: boolean; execution: ToolExecution }>;
  /** Compare-and-set on `version`; null when another writer won. */
  update(
    next: ToolExecution,
    expectedVersion: number,
    audit: AuditEntry,
  ): Promise<ToolExecution | null>;
  getByKey(tenantId: string, idempotencyKey: string): Promise<ToolExecution | null>;
  list(tenantId: string, query?: ExecutionQuery): Promise<ToolExecution[]>;
}

export interface ToolApprovalStore {
  create(request: ToolApprovalRequest, audit: AuditEntry): Promise<void>;
  get(tenantId: string, approvalRequestId: string): Promise<ToolApprovalRequest | null>;
  /** Only a PENDING request can be decided; null if it was not PENDING any more. */
  decide(next: ToolApprovalRequest, audit: AuditEntry): Promise<ToolApprovalRequest | null>;
  listPending(tenantId: string): Promise<ToolApprovalRequest[]>;
}

export interface ToolGrantStore {
  listForAgent(tenantId: string, agentId: string): Promise<ToolGrant[]>;
  /** Upsert of one exact (tenant, agent, tool, action) grant. */
  put(grant: ToolGrant, audit: AuditEntry): Promise<void>;
  revoke(
    grant: Pick<ToolGrant, "tenantId" | "agentId" | "toolId" | "action">,
    audit: AuditEntry,
  ): Promise<boolean>;
}
