import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Agent, AuditEntry, JsonValue } from "@/core/contracts";
import { hasPermission, type Role } from "@/core/identity";
import { containsSecret } from "@/core/memory/rules";
import {
  TOOL_FAILURE_RETRYABLE,
  findAction,
  toolIntentSchema,
  type ActionClass,
  type ConnectorDefinition,
  type ConnectorHealthRecord,
  type ConnectorInstance,
  type ConnectorStatus,
  type DuplicatePolicy,
  type RiskClass,
  type ToolActionDefinition,
  type ToolApprovalRequest,
  type ToolCaller,
  type ToolDefinition,
  type ToolExecution,
  type ToolFailureClass,
  type ToolGrant,
  type ToolIntent,
} from "@/core/tool-gateway/model";
import {
  approvalState,
  canDecideApproval,
  decideToolRequest,
  effectiveApproval,
  effectiveConnectorStatus,
  effectiveDuplicatePolicy,
  grantCovers,
  operationFingerprint,
  requestFingerprint,
} from "@/core/tool-gateway/policy";
import type { AgentLookup } from "@/server/repositories/ports";

import type { ConnectorRegistry } from "./in-memory";
import type {
  Connector,
  ConnectorContext,
  ConnectorHealthStore,
  ConnectorOutcome,
  CredentialResolver,
  SecretValue,
  ToolApprovalStore,
  ToolAuditPort,
  ToolExecutionStore,
  ToolGrantStore,
} from "./ports";

// ── Connector output trust boundary ──────────────────────────────────────────

/**
 * Everything a connector returns is DATA from outside ICOS. It is delivered
 * inside this envelope, never merged into instructions, and nothing in it is
 * ever read back by the gateway as policy, grant, approval or intent: the only
 * instruction channel is a new `ToolIntent` from a caller, decided afresh.
 */
export interface UntrustedToolResult {
  trust: "UNTRUSTED_EXTERNAL_DATA";
  contentType: "application/json";
  source: { connectorId: string; instanceId: string; toolId: string; action: ActionClass };
  toolExecutionId: string;
  scope: { tenantId: string };
  /** Live output on first execution; the persisted digest on an idempotent replay. */
  data: Record<string, JsonValue>;
  replayed: boolean;
}

// ── Cognitive Runtime port ───────────────────────────────────────────────────

export type ToolProgressEvent =
  | { type: "accepted"; toolExecutionId: string }
  | { type: "approval_required"; toolExecutionId: string; approvalRequestId: string }
  | { type: "dispatched"; toolExecutionId: string; attempt: number }
  | { type: "settled"; toolExecutionId: string; status: ToolExecution["status"] };

export type ToolOutcome =
  | {
      kind: "succeeded";
      toolExecutionId: string;
      result: UntrustedToolResult;
      replayed: boolean;
      auditReferences: string[];
    }
  | {
      kind: "approval_required";
      toolExecutionId: string;
      approvalRequestId: string;
      expiresAt: string;
      auditReferences: string[];
    }
  | { kind: "in_progress"; toolExecutionId: string; auditReferences: string[] }
  | {
      kind: "failed";
      toolExecutionId?: string;
      failureClass: ToolFailureClass;
      retryable: boolean;
      message: string;
      auditReferences: string[];
    };

/**
 * The ONLY contract the Cognitive Runtime needs: request a governed action,
 * discover what exists. It never sees credentials, grants internals or approvals.
 */
export interface ToolGatewayPort {
  execute(
    caller: ToolCaller,
    intent: unknown,
    opts?: { onProgress?: (e: ToolProgressEvent) => void },
  ): Promise<ToolOutcome>;
  inventory(caller: ToolCaller): Promise<ToolInventory>;
}

// ── Discovery ────────────────────────────────────────────────────────────────

export interface ToolInventory {
  tenantId: string;
  connectors: {
    connectorId: string;
    category: ConnectorDefinition["category"];
    availability: ConnectorDefinition["availability"];
    /** `credentialRef` is the opaque handle only; the secret never leaves the resolver. */
    instances: InstanceHealthView[];
    tools: {
      toolId: string;
      version: string;
      description: string;
      capabilities: string[];
      credentialRequired: boolean;
      actions: {
        action: ActionClass;
        description: string;
        risk: RiskClass;
        sideEffects: ToolActionDefinition["sideEffects"];
        idempotency: ToolActionDefinition["idempotency"];
        requiresApproval: boolean;
        duplicatePolicy: DuplicatePolicy;
        /** The caller holds an explicit, active grant for exactly this action. */
        permitted: boolean;
        inputSchema: Record<string, JsonValue>;
      }[];
    }[];
  }[];
}

export interface InstanceHealthView {
  instanceId: string;
  connectorId: string;
  /** Effective status from dated evidence; UNKNOWN when there is none or it is stale. */
  status: ConnectorStatus;
  checkedAt?: string;
  evidenceExpiresAt?: string;
  rateLimitedUntil?: string;
  credentialRef?: string;
}

// ── Cockpit read contract (read-only; mutations go through governed endpoints) ──

export interface ToolCockpitSnapshot {
  tenantId: string;
  generatedAt: string;
  connectorHealth: InstanceHealthView[];
  rateLimited: InstanceHealthView[];
  pendingApprovals: ToolApprovalRequest[];
  recentExecutions: ToolExecution[];
  failures: ToolExecution[];
  blocked: ToolExecution[];
  recentSideEffects: ToolExecution[];
  unsettled: ToolExecution[];
}

// ── Digital Workforce port ───────────────────────────────────────────────────

export interface ToolRequirement {
  toolId: string;
  action: ActionClass;
}
/** A role REQUIRES capabilities; it never grants them. `missing` must be granted explicitly. */
export interface CapabilityCoverage {
  granted: ToolRequirement[];
  missing: ToolRequirement[];
}
export interface ToolCapabilityPort {
  checkCapabilities(
    caller: ToolCaller,
    requirements: readonly ToolRequirement[],
  ): Promise<CapabilityCoverage>;
}

// ── Principals (resolved by the application boundary from a session, never from a body) ──

export type HumanPrincipal = { kind: "human"; id: string; roles: readonly Role[] };
export type AgentPrincipal = { kind: "agent"; id: string };

/** Why a request was refused before any execution row existed (audit `details.reason`). */
export type PreClaimDenial =
  | "INVALID_INTENT"
  | "UNKNOWN_CONNECTOR_INSTANCE"
  | "FOREIGN_CONNECTOR_INSTANCE"
  | "UNKNOWN_TOOL"
  | "MISSING_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_KEY_OF_ANOTHER_REQUESTER"
  | "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH"
  | "PERMISSION_DENIED"
  | "APPROVAL_DECISION_REFUSED"
  | "GRANT_CHANGE_REFUSED";

export interface ToolGatewayDeps {
  connectors: readonly Connector[];
  registry: ConnectorRegistry;
  health: ConnectorHealthStore;
  agents: AgentLookup;
  grants: ToolGrantStore;
  executions: ToolExecutionStore;
  approvals: ToolApprovalStore;
  credentials: CredentialResolver;
  audit: ToolAuditPort;
  /** Deployment overrides of duplicate policies, keyed `toolId:ACTION`. */
  duplicatePolicies?: Readonly<Record<string, DuplicatePolicy>>;
  /** How long a probe (or an observed auth failure) stays valid evidence. */
  healthTtlMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** Extra wait beyond a tool's timeout before an EXECUTING row is considered orphaned. */
  orphanGraceMs?: number;
}

const MAX_SUMMARY_BYTES = 4096;
const MAX_PREVIEW_BYTES = 8192;
const MAX_THROTTLE_SECONDS = 3600;
/**
 * Byte length of a JSON value as Postgres will see it: `jsonb::text` inserts a
 * space after every `:` and `,` (each 1 byte in the JSON), so ×2 bounds it.
 * The app limits are half the DB CHECKs, so a value we accept is one the DB accepts.
 */
const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
const DEFAULT_HEALTH_TTL_MS = 15 * 60_000;

export class ToolGateway implements ToolGatewayPort, ToolCapabilityPort {
  private readonly connectors: ReadonlyMap<string, Connector>;
  private readonly inputValidators = new Map<string, z.ZodType>();
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly d: ToolGatewayDeps) {
    this.connectors = new Map(d.connectors.map((c) => [c.definition.connectorId, c]));
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? ((p) => `${p}-${randomUUID()}`);
    // Declared input schemas are compiled once; an uncompilable schema is a
    // definition defect and must fail at composition, not at the first call.
    for (const c of d.connectors) {
      for (const t of c.definition.tools) {
        for (const a of t.actions) {
          this.inputValidators.set(`${t.toolId}:${a.action}`, z.fromJSONSchema(a.inputSchema));
        }
      }
    }
  }

  // ── execute ────────────────────────────────────────────────────────────────

  async execute(
    caller: ToolCaller,
    rawIntent: unknown,
    opts: { onProgress?: (e: ToolProgressEvent) => void } = {},
  ): Promise<ToolOutcome> {
    const progress = opts.onProgress ?? (() => {});
    const parsed = toolIntentSchema.safeParse(rawIntent);
    if (!parsed.success) {
      return this.denyPreClaim(caller, "INVALID_INTENT", "INVALID_INPUT", "invalid tool intent");
    }
    const intent = parsed.data;
    const now = this.now();
    const ref = {
      toolId: intent.toolId,
      action: intent.action,
      connectorInstanceId: intent.connectorInstanceId,
    };

    const instance = this.d.registry.get(caller.tenantId, intent.connectorInstanceId);
    if (!instance) {
      // Same answer for unknown and foreign (no existence oracle); the audit tells them apart.
      const foreign = this.d.registry.existsInAnotherTenant(
        caller.tenantId,
        intent.connectorInstanceId,
      );
      return this.denyPreClaim(
        caller,
        foreign ? "FOREIGN_CONNECTOR_INSTANCE" : "UNKNOWN_CONNECTOR_INSTANCE",
        "POLICY_DENIED",
        "connector instance not available to this tenant",
        ref,
      );
    }
    const connector = this.connectors.get(instance.connectorId);
    const tool = connector?.definition.tools.find((t) => t.toolId === intent.toolId);
    const actionDef = tool && findAction(tool, intent.action);
    if (!connector || !tool || !actionDef) {
      return this.denyPreClaim(caller, "UNKNOWN_TOOL", "NOT_FOUND", "unknown tool or action", ref);
    }
    if (actionDef.idempotency === "key_required" && !intent.idempotencyKey) {
      return this.denyPreClaim(
        caller,
        "MISSING_IDEMPOTENCY_KEY",
        "INVALID_INPUT",
        "idempotencyKey is required for this side-effecting action",
        ref,
      );
    }
    const idempotencyKey = intent.idempotencyKey ?? `auto:${this.newId("k")}`;
    const fingerprint = requestFingerprint(caller, intent);

    let exec = await this.d.executions.getByKey(caller.tenantId, idempotencyKey);
    if (exec) {
      const refused = await this.refuseResume(
        exec,
        caller,
        fingerprint,
        tool.toolId,
        actionDef,
        now,
        ref,
      );
      if (refused) return refused;
      const settled = await this.resumeExisting(exec, connector, tool, actionDef, instance);
      if (settled) return settled;
      exec = (await this.d.executions.getByKey(caller.tenantId, idempotencyKey))!;
    } else {
      const draft: ToolExecution = {
        toolExecutionId: this.newId("toolexec"),
        tenantId: caller.tenantId,
        idempotencyKey,
        requestFingerprint: fingerprint,
        operationFingerprint: operationFingerprint(caller.tenantId, intent),
        toolId: tool.toolId,
        toolVersion: tool.version,
        action: actionDef.action,
        connectorInstanceId: instance.instanceId,
        requesterAgentId: caller.agentId,
        missionId: intent.missionId,
        taskId: intent.taskId,
        riskClass: actionDef.risk,
        sideEffects: actionDef.sideEffects,
        status: "REQUESTED",
        settlementState: "NOT_STARTED",
        attemptCount: 0,
        auditReferences: [],
        version: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const audit = this.audit(draft, "tool.execution.recorded", { phase: "requested" });
      const claimed = await this.d.executions.claim(
        { ...draft, auditReferences: [audit.id] },
        audit,
      );
      exec = claimed.execution;
      if (!claimed.created) {
        // Lost a concurrent claim for the same key: behave as a retry.
        const refused = await this.refuseResume(
          exec,
          caller,
          fingerprint,
          tool.toolId,
          actionDef,
          now,
          ref,
        );
        if (refused) return refused;
        const settled = await this.resumeExisting(exec, connector, tool, actionDef, instance);
        if (settled) return settled;
        exec = (await this.d.executions.getByKey(caller.tenantId, idempotencyKey))!;
      }
      progress({ type: "accepted", toolExecutionId: exec.toolExecutionId });
    }

    // ── gateway-level input checks: evidence is the DENIED row, no connector call ──
    if (containsSecret(intent.input)) {
      return this.settleDenied(
        exec,
        "INVALID_INPUT",
        "credential-shaped content is not accepted in tool input",
      );
    }
    const validator = this.inputValidators.get(`${tool.toolId}:${actionDef.action}`);
    const valid = validator?.safeParse(intent.input);
    if (!valid?.success) {
      // Paths only, never values: the input may be personal data.
      const paths = valid?.error.issues.map((i) => i.path.join(".") || "(root)").slice(0, 10) ?? [];
      return this.settleDenied(
        exec,
        "INVALID_INPUT",
        `input does not match the declared schema at: ${paths.join(", ")}`,
      );
    }

    // ── policy ──
    const approvalReq = exec.approvalRequestId
      ? await this.d.approvals.get(caller.tenantId, exec.approvalRequestId)
      : null;
    const apState = approvalState(approvalReq ?? undefined, fingerprint, now);
    const decision = decideToolRequest({
      caller,
      agent: await this.resolveAgent(caller.agentId),
      connector: connector.definition,
      instance,
      status: await this.statusOf(instance, now),
      toolId: tool.toolId,
      action: actionDef,
      grants: await this.d.grants.listForAgent(caller.tenantId, caller.agentId),
      approval: apState,
      now,
    });

    if (decision.outcome === "deny") {
      if (decision.failureClass === "APPROVAL_REJECTED") {
        return this.transition(exec, {
          status: "REJECTED",
          failureClass: "APPROVAL_REJECTED",
          failureMessage: decision.reason,
        });
      }
      // An expired approval is spent; the next retry asks for a fresh one.
      const clear =
        decision.failureClass === "APPROVAL_EXPIRED" ? { approvalRequestId: undefined } : {};
      return this.settleDenied(exec, decision.failureClass, decision.reason, clear);
    }

    // ── duplicate operation (different key, same meaningful operation) ──
    const dup = await this.checkDuplicate(exec, tool, actionDef, intent, now);
    if (!dup.ok) return this.settleDenied(exec, "DUPLICATE_OPERATION", dup.message);
    if (dup.duplicateOf && exec.duplicateOf !== dup.duplicateOf)
      exec = { ...exec, duplicateOf: dup.duplicateOf };

    if (decision.outcome === "approval_required") {
      let req = approvalReq && apState === "pending" ? approvalReq : null;
      // The approver must see exactly what will run: no preview, no approval request.
      if (!req && jsonBytes(intent.input) > MAX_PREVIEW_BYTES) {
        return this.settleDenied(exec, "INVALID_INPUT", "input too large to present for approval");
      }
      if (!req) {
        const ttl = effectiveApproval(actionDef).ttlSeconds;
        req = {
          approvalRequestId: this.newId("toolappr"),
          tenantId: caller.tenantId,
          toolExecutionId: exec.toolExecutionId,
          requestFingerprint: fingerprint,
          requesterAgentId: caller.agentId,
          toolId: tool.toolId,
          action: actionDef.action,
          riskClass: actionDef.risk,
          inputPreview: intent.input,
          duplicateOf: exec.duplicateOf,
          status: "PENDING",
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
        };
        try {
          await this.d.approvals.create(
            req,
            this.audit(exec, "tool.approval.requested", {
              approvalRequestId: req.approvalRequestId,
            }),
          );
        } catch {
          return this.settleDenied(exec, "INVALID_INPUT", "approval request could not be recorded");
        }
      }
      const out = await this.transition(exec, {
        status: "AWAITING_APPROVAL",
        approvalRequestId: req.approvalRequestId,
        failureClass: "APPROVAL_REQUIRED",
        failureMessage: "approval required",
      });
      if (out.kind === "failed" && out.failureClass === "APPROVAL_REQUIRED") {
        progress({
          type: "approval_required",
          toolExecutionId: exec.toolExecutionId,
          approvalRequestId: req.approvalRequestId,
        });
        return {
          kind: "approval_required",
          toolExecutionId: exec.toolExecutionId,
          approvalRequestId: req.approvalRequestId,
          expiresAt: req.expiresAt,
          auditReferences: out.auditReferences,
        };
      }
      return out;
    }

    // ── allowed: local quota, credential, re-check, then dispatch exactly once ──
    if (!this.d.registry.take(`${instance.instanceId}:${tool.toolId}`, tool.rateLimit, now)) {
      return this.settleFailure(exec, "RATE_LIMIT", "NOT_APPLIED", "local rate limit reached");
    }
    const credential = await this.resolveCredential(tool, instance, caller.tenantId);
    if (!credential.ok) {
      return this.settleFailure(exec, credential.failureClass, "NOT_APPLIED", credential.message);
    }

    // Re-check what can change while we resolved the credential.
    const at = this.now();
    const stillGranted = grantCovers(
      await this.d.grants.listForAgent(caller.tenantId, caller.agentId),
      caller,
      tool.toolId,
      actionDef.action,
      at,
    );
    if (!stillGranted) {
      return this.settleDenied(exec, "PERMISSION_DENIED", "grant revoked before dispatch");
    }
    const needsApproval = effectiveApproval(actionDef).mode !== "none";
    if (needsApproval && approvalState(approvalReq ?? undefined, fingerprint, at) !== "approved") {
      return this.settleDenied(exec, "APPROVAL_EXPIRED", "approval lapsed before dispatch", {
        approvalRequestId: undefined,
      });
    }
    const dupAgain = await this.checkDuplicate(exec, tool, actionDef, intent, at);
    if (!dupAgain.ok) return this.settleDenied(exec, "DUPLICATE_OPERATION", dupAgain.message);

    return this.dispatch(
      exec,
      connector,
      tool,
      actionDef,
      instance,
      intent.input,
      credential.secret,
      needsApproval ? approvalReq!.approvalRequestId : undefined,
      progress,
    );
  }

  /**
   * Only the original requester, still allowed to use this action, may replay,
   * resume or trigger reconciliation of an execution. Another agent reusing the
   * key learns nothing about it (no id, no audit references). Audited.
   */
  private async refuseResume(
    exec: ToolExecution,
    caller: ToolCaller,
    fingerprint: string,
    toolId: string,
    action: ToolActionDefinition,
    now: Date,
    ref: Record<string, JsonValue>,
  ): Promise<ToolOutcome | null> {
    if (exec.requesterAgentId !== caller.agentId) {
      return this.denyPreClaim(
        caller,
        "IDEMPOTENCY_KEY_OF_ANOTHER_REQUESTER",
        "IDEMPOTENCY_CONFLICT",
        "idempotencyKey already used by another requester",
        ref,
      );
    }
    if (exec.requestFingerprint !== fingerprint) {
      const out = await this.denyPreClaim(
        caller,
        "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
        "IDEMPOTENCY_CONFLICT",
        "idempotencyKey reused for a different request",
        { ...ref, toolExecutionId: exec.toolExecutionId },
      );
      return { ...out, toolExecutionId: exec.toolExecutionId } as ToolOutcome;
    }
    const grants = await this.d.grants.listForAgent(caller.tenantId, caller.agentId);
    if (
      !(await this.resolveAgent(caller.agentId)) ||
      !grantCovers(grants, caller, toolId, action.action, now)
    ) {
      return this.denyPreClaim(
        caller,
        "PERMISSION_DENIED",
        "PERMISSION_DENIED",
        `no grant for ${toolId}:${action.action}`,
        ref,
      );
    }
    return null;
  }

  /** Terminal or in-flight rows are answered without re-dispatch. Returns null when re-decision is allowed. */
  private async resumeExisting(
    exec: ToolExecution,
    connector: Connector,
    tool: ToolDefinition,
    action: ToolActionDefinition,
    instance: ConnectorInstance,
  ): Promise<ToolOutcome | null> {
    switch (exec.status) {
      case "SUCCEEDED":
        return this.outcomeOf(exec);
      case "REJECTED":
        return fail(
          "APPROVAL_REJECTED",
          "approval was rejected; this request will never execute",
          exec,
        );
      case "EXECUTING": {
        if (!this.isOrphaned(exec, tool)) return this.outcomeOf(exec);
        const r = await this.reconcileOne(exec, connector, action, instance);
        return r.status === "FAILED" && r.settlementState === "NOT_APPLIED"
          ? null
          : this.outcomeOf(r);
      }
      case "FAILED": {
        if (exec.settlementState === "UNKNOWN") {
          // Retry-sensitive and outcome unknown: only reconciliation may settle it.
          const r = await this.reconcileOne(exec, connector, action, instance);
          return r.status === "FAILED" &&
            r.settlementState === "NOT_APPLIED" &&
            TOOL_FAILURE_RETRYABLE[r.failureClass ?? "UNKNOWN"]
            ? null
            : this.outcomeOf(r);
        }
        return TOOL_FAILURE_RETRYABLE[exec.failureClass ?? "UNKNOWN"] ? null : this.outcomeOf(exec);
      }
      case "REQUESTED":
      case "DENIED":
      case "AWAITING_APPROVAL":
        return null;
      default:
        return fail("UNKNOWN", "unrecognised execution state", exec);
    }
  }

  /**
   * Same operation (tenant, tool, action, instance, input) under another key,
   * inside the policy window, that applied / may have applied / is pending.
   */
  private async checkDuplicate(
    exec: ToolExecution,
    tool: ToolDefinition,
    action: ToolActionDefinition,
    intent: ToolIntent,
    now: Date,
  ): Promise<{ ok: true; duplicateOf?: string } | { ok: false; message: string }> {
    const policy = effectiveDuplicatePolicy(tool.toolId, action, this.d.duplicatePolicies);
    if (policy.mode === "allow") return { ok: true };
    const since = new Date(now.getTime() - policy.windowSeconds * 1000);
    const others = (
      await this.d.executions.findLiveByOperation(exec.tenantId, exec.operationFingerprint, since)
    ).filter((e) => e.toolExecutionId !== exec.toolExecutionId);
    if (others.length === 0) return { ok: true };
    const override = intent.duplicateOverride;
    if (
      policy.mode === "require_override" &&
      override &&
      others.some((e) => e.toolExecutionId === override.ofExecutionId)
    ) {
      return { ok: true, duplicateOf: override.ofExecutionId };
    }
    // Only the requester's OWN prior execution is named: another agent's id is not disclosed.
    const own = others.find((e) => e.requesterAgentId === exec.requesterAgentId);
    const prior = own ? ` of ${own.toolExecutionId}` : "";
    return {
      ok: false,
      message:
        policy.mode === "block"
          ? `duplicate operation${prior} within ${policy.windowSeconds}s`
          : `possible duplicate operation${prior} within ${policy.windowSeconds}s; repeat only with duplicateOverride.ofExecutionId`,
    };
  }

  private async dispatch(
    exec: ToolExecution,
    connector: Connector,
    tool: ToolDefinition,
    action: ToolActionDefinition,
    instance: ConnectorInstance,
    input: Record<string, JsonValue>,
    credential: SecretValue | undefined,
    approvalRequestId: string | undefined,
    progress: (e: ToolProgressEvent) => void,
  ): Promise<ToolOutcome> {
    const attempt = exec.attemptCount + 1;
    // The CAS below is the single point where a side effect is authorised: one winner per version.
    const dispatchAudit = this.audit(exec, "tool.execution.recorded", {
      phase: "dispatched",
      attempt,
      duplicateOf: exec.duplicateOf ?? null,
    });
    const dispatched = await this.d.executions.update(
      {
        ...exec,
        status: "EXECUTING",
        settlementState: "DISPATCHED",
        attemptCount: attempt,
        failureClass: undefined,
        failureMessage: undefined,
        startedAt: exec.startedAt ?? this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        auditReferences: [...exec.auditReferences, dispatchAudit.id],
      },
      exec.version,
      dispatchAudit,
    );
    if (!dispatched) {
      return {
        kind: "in_progress",
        toolExecutionId: exec.toolExecutionId,
        auditReferences: exec.auditReferences,
      };
    }
    // Only the CAS winner consumes the approval; an approval never covers two dispatches.
    if (approvalRequestId) {
      const at = this.now().toISOString();
      const consumed = await this.d.approvals.consume(
        exec.tenantId,
        approvalRequestId,
        at,
        this.audit(dispatched, "tool.approval.consumed", { approvalRequestId }),
      );
      if (!consumed) {
        return this.settleFailure(
          dispatched,
          "APPROVAL_REQUIRED",
          "NOT_APPLIED",
          "approval already used",
        );
      }
    }
    progress({ type: "dispatched", toolExecutionId: exec.toolExecutionId, attempt });

    const ctx: ConnectorContext = {
      // A copy: nothing the connector does to it reaches the registry.
      instance: structuredClone(instance),
      credential,
      signal: AbortSignal.timeout(tool.timeoutMs),
      idempotencyKey: exec.idempotencyKey,
      toolExecutionId: exec.toolExecutionId,
    };
    const result = await runWithTimeout(
      () => connector.execute(tool.toolId, action.action, structuredClone(input), ctx),
      tool.timeoutMs,
    );
    const now = this.now();

    let out: ToolOutcome;
    if (result.ok) {
      const output = credential ? scrub(result.output, credential.reveal()) : result.output;
      out = await this.transition(dispatched, {
        status: "SUCCEEDED",
        settlementState: "APPLIED",
        providerOperationId: safeRef(result.providerOperationId, credential),
        resultReference: safeRef(result.resultReference, credential),
        resultSummary:
          tool.auditPolicy.persistResult === "summary"
            ? safeSummary(result.summary, credential)
            : undefined,
        resultTrust: "UNTRUSTED_EXTERNAL_DATA",
        finishedAt: now.toISOString(),
      });
      if (out.kind === "succeeded") {
        out = {
          ...out,
          replayed: false,
          result: { ...out.result, data: toJsonRecord(output), replayed: false },
        };
      }
    } else {
      // Health bookkeeping is best-effort: it must never throw past the settlement below.
      try {
        if (result.failureClass === "AUTH_FAILURE")
          await this.markHealth(instance, "AUTH_FAILED", "provider refused the credential");
        if (result.failureClass === "RATE_LIMIT")
          await this.markRateLimited(instance, now, result.retryAfterSeconds);
      } catch {
        /* the settlement is the evidence that matters */
      }
      // A failure of an effect-free action cannot have applied anything.
      const settlement = action.sideEffects === "none" ? "NOT_APPLIED" : result.settlement;
      const message = credential
        ? result.message.split(credential.reveal()).join("[REDACTED]")
        : result.message;
      out = await this.settleFailure(
        dispatched,
        result.failureClass,
        settlement,
        message.slice(0, 500),
      );
    }
    progress({
      type: "settled",
      toolExecutionId: exec.toolExecutionId,
      status: out.kind === "succeeded" ? "SUCCEEDED" : "FAILED",
    });
    return out;
  }

  // ── health & reconciliation (boot, scheduler, after ambiguity) ──────────────

  /**
   * Probe every instance of a tenant and record dated evidence. A disabled or
   * contract-only connector is DISABLED; a probe that throws or times out is
   * UNKNOWN. Nothing is ever assumed HEALTHY.
   */
  async probeHealth(tenantId: string): Promise<InstanceHealthView[]> {
    for (const instance of this.d.registry.list(tenantId)) await this.probeInstance(instance);
    return this.healthViews(tenantId, this.now());
  }

  private async probeInstance(instance: ConnectorInstance): Promise<void> {
    const connector = this.connectors.get(instance.connectorId);
    let status: ConnectorStatus;
    let detail: string | undefined;
    if (!instance.enabled) status = "DISABLED";
    else if (!connector || connector.definition.availability !== "CONNECTED") status = "DISABLED";
    else {
      const needsCred =
        instance.credential !== undefined ||
        connector.definition.tools.some((t) => t.credential?.required);
      const cred = needsCred
        ? await this.resolveCredentialFor(instance, instance.tenantId)
        : { ok: true as const, secret: undefined };
      if (!cred.ok) {
        status = cred.reason === "tenant_mismatch" ? "DISABLED" : "AUTH_FAILED";
        detail = `credential ${cred.reason}`;
      } else {
        let timer: NodeJS.Timeout | undefined;
        status = await Promise.race([
          connector
            .health({
              instance: structuredClone(instance),
              credential: cred.secret,
              signal: AbortSignal.timeout(10_000),
            })
            .catch(() => "UNKNOWN" as const),
          new Promise<"UNKNOWN">((r) => {
            timer = setTimeout(() => r("UNKNOWN"), 10_000);
          }),
        ]).finally(() => clearTimeout(timer));
      }
    }
    await this.markHealth(instance, status, detail);
  }

  /** Settle orphaned or unknown side effects of a tenant. Safe at boot and periodically. */
  async reconcile(tenantId: string): Promise<ToolExecution[]> {
    // Two queries so unresolvable UNKNOWN rows can never starve orphaned EXECUTING ones.
    const rows = [
      ...(await this.d.executions.list(tenantId, { status: ["EXECUTING"], limit: 500 })),
      ...(await this.d.executions.list(tenantId, {
        status: ["FAILED"],
        settlement: ["DISPATCHED", "UNKNOWN"],
        limit: 500,
      })),
    ];
    const settled: ToolExecution[] = [];
    for (const row of rows) {
      const instance = this.d.registry.get(tenantId, row.connectorInstanceId);
      const connector = instance && this.connectors.get(instance.connectorId);
      const tool = connector?.definition.tools.find((t) => t.toolId === row.toolId);
      const action = tool && findAction(tool, row.action);
      if (!instance || !connector || !tool || !action) continue;
      if (row.status === "EXECUTING" && !this.isOrphaned(row, tool)) continue;
      const before = row.version;
      const after = await this.reconcileOne(row, connector, action, instance);
      if (after.version !== before) settled.push(after);
    }
    return settled;
  }

  private isOrphaned(exec: ToolExecution, tool: ToolDefinition): boolean {
    const grace = this.d.orphanGraceMs ?? 30_000;
    return this.now().getTime() - new Date(exec.updatedAt).getTime() > tool.timeoutMs + grace;
  }

  private async reconcileOne(
    exec: ToolExecution,
    connector: Connector,
    action: ToolActionDefinition,
    instance: ConnectorInstance,
  ): Promise<ToolExecution> {
    let outcome: Awaited<ReturnType<NonNullable<Connector["reconcile"]>>> = {
      settlement: "UNKNOWN",
    };
    if (exec.sideEffects === "none") {
      outcome = { settlement: "NOT_APPLIED" };
    } else if (
      connector.reconcile &&
      action.reconcilable &&
      connector.definition.supportsReconcile
    ) {
      const tool = connector.definition.tools.find((t) => t.toolId === exec.toolId)!;
      const cred = await this.resolveCredential(tool, instance, exec.tenantId);
      try {
        outcome = await connector.reconcile(
          exec.toolId,
          exec.action,
          { idempotencyKey: exec.idempotencyKey, providerOperationId: exec.providerOperationId },
          {
            instance: structuredClone(instance),
            credential: cred.ok ? cred.secret : undefined,
            signal: AbortSignal.timeout(tool.timeoutMs),
            idempotencyKey: exec.idempotencyKey,
            toolExecutionId: exec.toolExecutionId,
          },
        );
      } catch {
        outcome = { settlement: "UNKNOWN" };
      }
    }
    // Already recorded as unresolvable and still unresolvable: no new version, no audit churn.
    if (
      outcome.settlement === "UNKNOWN" &&
      exec.status === "FAILED" &&
      exec.failureClass === "SETTLEMENT_UNKNOWN"
    ) {
      return exec;
    }
    const now = this.now().toISOString();
    const patch: Partial<ToolExecution> =
      outcome.settlement === "APPLIED"
        ? {
            status: "SUCCEEDED",
            settlementState: "APPLIED",
            providerOperationId:
              safeRef(outcome.providerOperationId, undefined) ?? exec.providerOperationId,
            resultSummary: safeSummary(outcome.summary, undefined),
            resultTrust: "UNTRUSTED_EXTERNAL_DATA",
            failureClass: undefined,
            failureMessage: undefined,
            finishedAt: now,
          }
        : outcome.settlement === "NOT_APPLIED"
          ? {
              status: "FAILED",
              settlementState: "NOT_APPLIED",
              failureClass:
                exec.failureClass && TOOL_FAILURE_RETRYABLE[exec.failureClass]
                  ? exec.failureClass
                  : "PROVIDER_UNAVAILABLE",
              failureMessage: "reconciled: not applied at provider",
              finishedAt: now,
            }
          : {
              status: "FAILED",
              settlementState: "UNKNOWN",
              failureClass: "SETTLEMENT_UNKNOWN",
              failureMessage: "side effect outcome unknown; manual reconciliation required",
              finishedAt: now,
            };
    const audit = this.audit(exec, "tool.execution.recorded", {
      phase: "reconciled",
      settlement: outcome.settlement,
    });
    const next = {
      ...exec,
      ...patch,
      updatedAt: now,
      auditReferences: [...exec.auditReferences, audit.id],
    };
    const saved = await this.d.executions.update(next, exec.version, audit);
    return saved ?? (await this.d.executions.getByKey(exec.tenantId, exec.idempotencyKey)) ?? exec;
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  async listPendingApprovals(tenantId: string): Promise<ToolApprovalRequest[]> {
    return this.d.approvals.listPending(tenantId);
  }

  async getApproval(
    tenantId: string,
    approvalRequestId: string,
  ): Promise<ToolApprovalRequest | null> {
    return this.d.approvals.get(tenantId, approvalRequestId);
  }

  /** Decide an approval; every refusal is itself audited (who tried, what, why). */
  async decideApproval(
    tenantId: string,
    approvalRequestId: string,
    approver: HumanPrincipal | AgentPrincipal,
    decision: "APPROVED" | "REJECTED",
    reason?: string,
  ): Promise<
    | { ok: true; request: ToolApprovalRequest }
    | { ok: false; failureClass: ToolFailureClass; message: string }
  > {
    const r = await this.decideApprovalChecked(
      tenantId,
      approvalRequestId,
      approver,
      decision,
      reason,
    );
    if (!r.ok) {
      await this.auditRefusal(tenantId, approver, "APPROVAL_DECISION_REFUSED", r.failureClass, {
        approvalRequestId: approvalRequestId.slice(0, 128),
        decision,
      });
    }
    return r;
  }

  private async decideApprovalChecked(
    tenantId: string,
    approvalRequestId: string,
    approver: HumanPrincipal | AgentPrincipal,
    decision: "APPROVED" | "REJECTED",
    reason?: string,
  ): Promise<
    | { ok: true; request: ToolApprovalRequest }
    | { ok: false; failureClass: ToolFailureClass; message: string }
  > {
    const req = await this.d.approvals.get(tenantId, approvalRequestId);
    if (!req)
      return { ok: false, failureClass: "NOT_FOUND", message: "approval request not found" };
    if (req.status !== "PENDING")
      return { ok: false, failureClass: "CONFLICT", message: "already decided" };
    const now = this.now();
    if (new Date(req.expiresAt) <= now) {
      return { ok: false, failureClass: "APPROVAL_EXPIRED", message: "approval request expired" };
    }
    if (decision === "REJECTED" && !reason?.trim()) {
      return {
        ok: false,
        failureClass: "INVALID_INPUT",
        message: "a reason is required to reject",
      };
    }
    if (approver.kind === "human" && !hasPermission(approver.roles, "approvals.decide")) {
      return { ok: false, failureClass: "PERMISSION_DENIED", message: "approvals.decide required" };
    }
    // An approving agent needs the kernel's operator level (the level to act on reversible changes).
    const approvingAgent = approver.kind === "agent" ? await this.resolveAgent(approver.id) : null;
    if (approver.kind === "agent" && (!approvingAgent || approvingAgent.authorizationLevel < 2)) {
      return { ok: false, failureClass: "PERMISSION_DENIED", message: "unknown approving agent" };
    }
    const action = this.actionOf(req.toolId, req.action);
    if (!action || !canDecideApproval(action, req, approver)) {
      return {
        ok: false,
        failureClass: "PERMISSION_DENIED",
        message: "this principal may not decide this approval",
      };
    }
    const ttl = effectiveApproval(action).ttlSeconds;
    const next: ToolApprovalRequest = {
      ...req,
      status: decision,
      decidedBy: { kind: approver.kind, id: approver.id },
      reason,
      decidedAt: now.toISOString(),
      // An approval must be used within its TTL from the decision.
      expiresAt:
        decision === "APPROVED"
          ? new Date(now.getTime() + ttl * 1000).toISOString()
          : req.expiresAt,
    };
    const saved = await this.d.approvals.decide(next, {
      ...this.baseAudit(
        tenantId,
        { kind: approver.kind, id: approver.id },
        "tool.approval.decided",
      ),
      details: {
        tenantId,
        approvalRequestId,
        toolExecutionId: req.toolExecutionId,
        toolId: req.toolId,
        action: req.action,
        decision,
        reason: reason ?? null,
      },
    });
    return saved
      ? { ok: true, request: saved }
      : { ok: false, failureClass: "CONFLICT", message: "already decided" };
  }

  // ── grant administration & Digital Workforce coverage ──────────────────────

  /**
   * Grant or revoke one exact action of one tool to one agent. Only a HUMAN
   * with `agentCapabilities.write` (the authority that assigns capabilities to
   * agents, Lot C1) can: no agent — requester or not — can grant anything.
   */
  async setGrant(
    admin: HumanPrincipal,
    input: {
      tenantId: string;
      agentId: string;
      toolId: string;
      action: ActionClass;
      reason: string;
      expiresAt?: string;
    },
    op: "grant" | "revoke",
  ): Promise<
    { ok: true; grant?: ToolGrant } | { ok: false; failureClass: ToolFailureClass; message: string }
  > {
    const r = await this.setGrantChecked(admin, input, op);
    if (!r.ok) {
      const actor =
        admin?.kind === "human" || admin?.kind === "agent"
          ? { kind: admin.kind, id: String(admin.id).slice(0, 128) }
          : { kind: "agent" as const, id: "unknown" };
      await this.auditRefusal(input.tenantId, actor, "GRANT_CHANGE_REFUSED", r.failureClass, {
        agentId: String(input.agentId).slice(0, 128),
        toolId: String(input.toolId).slice(0, 128),
        action: input.action,
        op,
      });
    }
    return r;
  }

  private async setGrantChecked(
    admin: HumanPrincipal,
    input: {
      tenantId: string;
      agentId: string;
      toolId: string;
      action: ActionClass;
      reason: string;
      expiresAt?: string;
    },
    op: "grant" | "revoke",
  ): Promise<
    { ok: true; grant?: ToolGrant } | { ok: false; failureClass: ToolFailureClass; message: string }
  > {
    if (admin?.kind !== "human") {
      return {
        ok: false,
        failureClass: "PERMISSION_DENIED",
        message: "only a human may change grants",
      };
    }
    if (!hasPermission(admin.roles, "agentCapabilities.write")) {
      return {
        ok: false,
        failureClass: "PERMISSION_DENIED",
        message: "agentCapabilities.write required",
      };
    }
    if (!input.reason?.trim())
      return { ok: false, failureClass: "INVALID_INPUT", message: "a reason is required" };
    if (!this.actionOf(input.toolId, input.action)) {
      return { ok: false, failureClass: "NOT_FOUND", message: "unknown tool action" };
    }
    const at = this.now().toISOString();
    const key = {
      tenantId: input.tenantId,
      agentId: input.agentId,
      toolId: input.toolId,
      action: input.action,
    };
    const audit = {
      ...this.baseAudit(
        input.tenantId,
        { kind: "human" as const, id: admin.id },
        "tool.grant.changed",
      ),
      details: { ...key, op, reason: input.reason, expiresAt: input.expiresAt ?? null },
    };
    if (op === "revoke") {
      const ok = await this.d.grants.revoke(
        key,
        { revokedAt: at, revokedBy: admin.id, revokeReason: input.reason },
        audit,
      );
      return ok
        ? { ok: true }
        : { ok: false, failureClass: "NOT_FOUND", message: "no active grant" };
    }
    if (!(await this.resolveAgent(input.agentId))) {
      return { ok: false, failureClass: "NOT_FOUND", message: "unknown agent" };
    }
    const grant: ToolGrant = {
      ...key,
      grantedBy: admin.id,
      grantedAt: at,
      reason: input.reason,
      expiresAt: input.expiresAt,
    };
    await this.d.grants.put(grant, audit);
    return { ok: true, grant };
  }

  async listGrants(tenantId: string, agentId?: string): Promise<ToolGrant[]> {
    return agentId
      ? this.d.grants.listForAgent(tenantId, agentId)
      : this.d.grants.listForTenant(tenantId);
  }

  /** Report which role requirements are covered by explicit grants. Grants nothing. */
  async checkCapabilities(
    caller: ToolCaller,
    requirements: readonly ToolRequirement[],
  ): Promise<CapabilityCoverage> {
    const grants = await this.d.grants.listForAgent(caller.tenantId, caller.agentId);
    const now = this.now();
    const coverage: CapabilityCoverage = { granted: [], missing: [] };
    for (const r of requirements) {
      (grantCovers(grants, caller, r.toolId, r.action, now)
        ? coverage.granted
        : coverage.missing
      ).push({
        toolId: r.toolId,
        action: r.action,
      });
    }
    return coverage;
  }

  // ── discovery & cockpit ────────────────────────────────────────────────────

  async inventory(caller: ToolCaller): Promise<ToolInventory> {
    const now = this.now();
    const grants = await this.d.grants.listForAgent(caller.tenantId, caller.agentId);
    const health = await this.healthViews(caller.tenantId, now);
    return {
      tenantId: caller.tenantId,
      connectors: [...this.connectors.values()].map(({ definition: c }) => ({
        connectorId: c.connectorId,
        category: c.category,
        availability: c.availability,
        instances: health.filter((h) => h.connectorId === c.connectorId),
        tools: c.tools.map((t) => ({
          toolId: t.toolId,
          version: t.version,
          description: t.description,
          capabilities: [...t.capabilities],
          credentialRequired: t.credential?.required ?? false,
          actions: t.actions.map((a) => ({
            action: a.action,
            description: a.description,
            risk: a.risk,
            sideEffects: a.sideEffects,
            idempotency: a.idempotency,
            requiresApproval: effectiveApproval(a).mode !== "none",
            duplicatePolicy: effectiveDuplicatePolicy(t.toolId, a, this.d.duplicatePolicies),
            permitted: grantCovers(grants, caller, t.toolId, a.action, now),
            inputSchema: a.inputSchema,
          })),
        })),
      })),
    };
  }

  async cockpitSnapshot(tenantId: string, limit = 50): Promise<ToolCockpitSnapshot> {
    const now = this.now();
    const health = await this.healthViews(tenantId, now);
    const list = (q: Parameters<ToolExecutionStore["list"]>[1]) =>
      this.d.executions.list(tenantId, q);
    return {
      tenantId,
      generatedAt: now.toISOString(),
      connectorHealth: health,
      rateLimited: health.filter((h) => h.status === "RATE_LIMITED"),
      pendingApprovals: await this.d.approvals.listPending(tenantId),
      recentExecutions: await list({ limit }),
      failures: await list({ status: ["FAILED"], limit }),
      blocked: await list({ status: ["DENIED", "REJECTED"], limit }),
      recentSideEffects: (await list({ settlement: ["APPLIED"], limit })).filter(
        (e) => e.sideEffects !== "none",
      ),
      unsettled: await list({ settlement: ["DISPATCHED", "UNKNOWN"], limit }),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async healthViews(tenantId: string, now: Date): Promise<InstanceHealthView[]> {
    const views: InstanceHealthView[] = [];
    for (const i of this.d.registry.list(tenantId)) {
      const rec = await this.d.health.get(tenantId, i.instanceId);
      const status = effectiveConnectorStatus(i, rec, now);
      views.push({
        instanceId: i.instanceId,
        connectorId: i.connectorId,
        status,
        checkedAt: rec?.checkedAt,
        evidenceExpiresAt: rec?.expiresAt,
        rateLimitedUntil: status === "RATE_LIMITED" ? rec?.rateLimitedUntil : undefined,
        credentialRef: i.credential?.ref,
      });
    }
    return views;
  }

  /**
   * Live status for a dispatch decision. Missing or expired evidence triggers a
   * real probe of THIS instance (so a gateway whose scheduler job is not wired
   * yet does not die after one TTL); the probe's result, not an assumption, decides.
   */
  private async statusOf(instance: ConnectorInstance, now: Date): Promise<ConnectorStatus> {
    const rec = await this.d.health.get(instance.tenantId, instance.instanceId);
    if (instance.enabled && (!rec || new Date(rec.expiresAt) <= now)) {
      await this.probeInstance(instance);
    }
    return this.statusOfRecorded(instance, now);
  }

  private async statusOfRecorded(instance: ConnectorInstance, now: Date): Promise<ConnectorStatus> {
    return effectiveConnectorStatus(
      instance,
      await this.d.health.get(instance.tenantId, instance.instanceId),
      now,
    );
  }

  private async markHealth(instance: ConnectorInstance, status: ConnectorStatus, detail?: string) {
    const now = this.now();
    const prev = await this.d.health.get(instance.tenantId, instance.instanceId);
    const throttled =
      prev?.rateLimitedUntil && new Date(prev.rateLimitedUntil) > now
        ? prev.rateLimitedUntil
        : undefined;
    const record: ConnectorHealthRecord = {
      tenantId: instance.tenantId,
      instanceId: instance.instanceId,
      status,
      checkedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (this.d.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS),
      ).toISOString(),
      rateLimitedUntil: throttled,
      detail,
    };
    await this.d.health.put(record);
  }

  /** A provider's Retry-After is untrusted: clamped to [1 s, 1 h], 60 s when absent or absurd. */
  private async markRateLimited(instance: ConnectorInstance, now: Date, retryAfter?: number) {
    const seconds =
      retryAfter !== undefined && Number.isFinite(retryAfter)
        ? Math.min(Math.max(Math.round(retryAfter), 1), MAX_THROTTLE_SECONDS)
        : 60;
    const until = new Date(now.getTime() + seconds * 1000);
    const prev = await this.d.health.get(instance.tenantId, instance.instanceId);
    await this.d.health.put({
      tenantId: instance.tenantId,
      instanceId: instance.instanceId,
      // No probe evidence yet → the throttle is all we know; it reads UNKNOWN once lapsed.
      status: prev?.status ?? "RATE_LIMITED",
      checkedAt: prev?.checkedAt ?? now.toISOString(),
      expiresAt: new Date(
        Math.max(until.getTime(), prev ? new Date(prev.expiresAt).getTime() : 0),
      ).toISOString(),
      rateLimitedUntil: until.toISOString(),
      detail: "provider rate limit",
    });
  }

  private actionOf(toolId: string, action: ActionClass): ToolActionDefinition | undefined {
    for (const c of this.connectors.values()) {
      const t = c.definition.tools.find((x) => x.toolId === toolId);
      if (t) return findAction(t, action);
    }
    return undefined;
  }

  private async resolveAgent(id: string): Promise<Agent | null> {
    return this.d.agents.getById(id);
  }

  private async resolveCredentialFor(instance: ConnectorInstance, tenantId: string) {
    if (!instance.credential) return { ok: false as const, reason: "not_found" as const };
    return this.d.credentials.resolve(instance.credential, tenantId);
  }

  private async resolveCredential(
    tool: ToolDefinition,
    instance: ConnectorInstance,
    tenantId: string,
  ): Promise<
    | { ok: true; secret?: SecretValue }
    | { ok: false; failureClass: ToolFailureClass; message: string }
  > {
    // Required by the tool, or configured on the instance (optional-auth APIs): resolve it.
    if (!tool.credential?.required && !instance.credential) return { ok: true };
    const r = await this.resolveCredentialFor(instance, tenantId);
    if (r.ok) return { ok: true, secret: r.secret };
    if (r.reason !== "tenant_mismatch")
      await this.markHealth(instance, "AUTH_FAILED", `credential ${r.reason}`);
    return {
      ok: false,
      failureClass: r.reason === "tenant_mismatch" ? "POLICY_DENIED" : "AUTH_FAILURE",
      message: `credential ${instance.credential?.ref ?? "(none)"}: ${r.reason}`,
    };
  }

  private baseAudit(
    tenantId: string,
    actor: AuditEntry["actor"],
    eventType: AuditEntry["eventType"],
  ) {
    const at = this.now().toISOString();
    return {
      id: this.newId("audit"),
      occurredAt: at,
      createdAt: at,
      eventType,
      actor,
      details: { tenantId },
    };
  }

  private audit(
    exec: ToolExecution,
    eventType: AuditEntry["eventType"],
    extra: Record<string, JsonValue>,
  ): AuditEntry {
    return {
      ...this.baseAudit(exec.tenantId, { kind: "agent", id: exec.requesterAgentId }, eventType),
      details: {
        tenantId: exec.tenantId,
        toolExecutionId: exec.toolExecutionId,
        toolId: exec.toolId,
        action: exec.action,
        riskClass: exec.riskClass,
        missionId: exec.missionId ?? null,
        taskId: exec.taskId ?? null,
        ...extra,
      },
    };
  }

  /**
   * A refusal before any execution row exists is still evidence. Only closed,
   * validated identifiers are recorded — never the input, never a secret.
   */
  private async denyPreClaim(
    caller: ToolCaller,
    reason: PreClaimDenial,
    failureClass: ToolFailureClass,
    message: string,
    ref: Record<string, JsonValue> = {},
  ): Promise<ToolOutcome> {
    const entry: AuditEntry = {
      ...this.baseAudit(
        caller.tenantId,
        { kind: "agent", id: caller.agentId },
        "tool.request.denied",
      ),
      details: { tenantId: caller.tenantId, reason, failureClass, ...ref },
    };
    await this.d.audit.append(entry);
    return { ...fail(failureClass, message), auditReferences: [entry.id] };
  }

  private async auditRefusal(
    tenantId: string,
    actor: { kind: "human" | "agent"; id: string },
    reason: PreClaimDenial,
    failureClass: ToolFailureClass,
    ref: Record<string, JsonValue>,
  ): Promise<void> {
    await this.d.audit.append({
      ...this.baseAudit(tenantId, actor, "tool.request.denied"),
      details: { tenantId, reason, failureClass, ...ref },
    });
  }

  private async transition(
    exec: ToolExecution,
    patch: Partial<ToolExecution>,
  ): Promise<ToolOutcome> {
    const next: ToolExecution = { ...exec, ...patch, updatedAt: this.now().toISOString() };
    const audit = this.audit(next, "tool.execution.recorded", {
      phase: "settled",
      status: next.status,
      settlementState: next.settlementState,
      failureClass: next.failureClass ?? null,
      attempt: next.attemptCount,
      providerOperationId: next.providerOperationId ?? null,
      duplicateOf: next.duplicateOf ?? null,
    });
    next.auditReferences = [...exec.auditReferences, audit.id];
    const saved = await this.d.executions.update(next, exec.version, audit);
    if (!saved) {
      const current = await this.d.executions.getByKey(exec.tenantId, exec.idempotencyKey);
      return current?.status === "EXECUTING"
        ? {
            kind: "in_progress",
            toolExecutionId: exec.toolExecutionId,
            auditReferences: current.auditReferences,
          }
        : fail("CONFLICT", "concurrent update of this execution", current ?? exec);
    }
    return this.outcomeOf(saved);
  }

  private settleDenied(
    exec: ToolExecution,
    cls: ToolFailureClass,
    message: string,
    extra: Partial<ToolExecution> = {},
  ) {
    return this.transition(exec, {
      status: "DENIED",
      failureClass: cls,
      failureMessage: message.slice(0, 500),
      ...extra,
    });
  }

  private settleFailure(
    exec: ToolExecution,
    cls: ToolFailureClass,
    settlement: "NOT_APPLIED" | "UNKNOWN",
    message: string,
  ) {
    return this.transition(exec, {
      status: "FAILED",
      settlementState:
        exec.settlementState === "NOT_STARTED" && settlement === "NOT_APPLIED"
          ? "NOT_STARTED"
          : settlement,
      failureClass: cls,
      failureMessage: message,
      finishedAt: this.now().toISOString(),
    });
  }

  private outcomeOf(e: ToolExecution): ToolOutcome {
    switch (e.status) {
      case "SUCCEEDED": {
        const instance = this.d.registry.get(e.tenantId, e.connectorInstanceId);
        return {
          kind: "succeeded",
          toolExecutionId: e.toolExecutionId,
          replayed: true,
          auditReferences: e.auditReferences,
          result: {
            trust: "UNTRUSTED_EXTERNAL_DATA",
            contentType: "application/json",
            source: {
              connectorId: instance?.connectorId ?? "unknown",
              instanceId: e.connectorInstanceId,
              toolId: e.toolId,
              action: e.action,
            },
            toolExecutionId: e.toolExecutionId,
            scope: { tenantId: e.tenantId },
            data: e.resultSummary ?? {},
            replayed: true,
          },
        };
      }
      case "EXECUTING":
        return {
          kind: "in_progress",
          toolExecutionId: e.toolExecutionId,
          auditReferences: e.auditReferences,
        };
      default: {
        const cls = e.failureClass ?? "UNKNOWN";
        // Unknown settlement is never "retry it": the caller must wait for reconciliation.
        const retryable = e.settlementState !== "UNKNOWN" && TOOL_FAILURE_RETRYABLE[cls];
        return {
          kind: "failed",
          toolExecutionId: e.toolExecutionId,
          failureClass: cls,
          retryable,
          message: e.failureMessage ?? cls,
          auditReferences: e.auditReferences,
        };
      }
    }
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

function fail(failureClass: ToolFailureClass, message: string, exec?: ToolExecution): ToolOutcome {
  return {
    kind: "failed",
    toolExecutionId: exec?.toolExecutionId,
    failureClass,
    retryable: TOOL_FAILURE_RETRYABLE[failureClass],
    message,
    auditReferences: exec?.auditReferences ?? [],
  };
}

async function runWithTimeout(
  run: () => Promise<ConnectorOutcome>,
  ms: number,
): Promise<ConnectorOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ConnectorOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          failureClass: "TIMEOUT",
          settlement: "UNKNOWN",
          message: `timed out after ${ms} ms`,
        }),
      ms,
    );
  });
  try {
    return await Promise.race([
      run().catch((e: unknown): ConnectorOutcome => ({
        ok: false,
        failureClass: e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : "UNKNOWN",
        settlement: "UNKNOWN",
        message: e instanceof Error ? e.name : "connector error",
      })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Connector output must be plain JSON data: anything else (functions, classes) is dropped. */
function toJsonRecord(value: unknown): Record<string, JsonValue> {
  try {
    const v = JSON.parse(JSON.stringify(value ?? {}));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return {};
  }
}

/** Replace every occurrence of the secret in a JSON value (a connector echoing it must not leak it). */
function scrub<T extends JsonValue | Record<string, JsonValue>>(value: T, secret: string): T {
  if (!secret) return value;
  return JSON.parse(
    JSON.stringify(value).split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]"),
  ) as T;
}

/** Provider-supplied identifiers are persisted and audited: drop anything secret-shaped. */
function safeRef(
  value: string | undefined,
  credential: SecretValue | undefined,
): string | undefined {
  if (value === undefined || containsSecret(value)) return undefined;
  if (credential && value.includes(credential.reveal())) return undefined;
  return value;
}

function safeSummary(
  summary: Record<string, JsonValue> | undefined,
  credential: SecretValue | undefined,
): Record<string, JsonValue> | undefined {
  if (!summary) return undefined;
  const s = credential ? scrub(toJsonRecord(summary), credential.reveal()) : toJsonRecord(summary);
  if (containsSecret(s) || jsonBytes(s) > MAX_SUMMARY_BYTES) return { redacted: true };
  return s;
}
