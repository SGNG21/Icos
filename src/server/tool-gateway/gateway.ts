import { randomUUID } from "node:crypto";

import type { Agent, AuditEntry, JsonValue } from "@/core/contracts";
import { hasPermission, type Role } from "@/core/identity";
import { containsSecret } from "@/core/memory/rules";
import {
  TOOL_FAILURE_RETRYABLE,
  findAction,
  toolIntentSchema,
  type ActionClass,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ConnectorStatus,
  type RiskClass,
  type ToolActionDefinition,
  type ToolApprovalRequest,
  type ToolCaller,
  type ToolDefinition,
  type ToolExecution,
  type ToolFailureClass,
  type ToolGrant,
} from "@/core/tool-gateway/model";
import {
  approvalState,
  canDecideApproval,
  decideToolRequest,
  effectiveApproval,
  grantCovers,
  requestFingerprint,
} from "@/core/tool-gateway/policy";
import type { AgentLookup } from "@/server/repositories/ports";

import type { ConnectorRegistry } from "./in-memory";
import type {
  Connector,
  ConnectorContext,
  ConnectorOutcome,
  CredentialResolver,
  SecretValue,
  ToolApprovalStore,
  ToolExecutionStore,
  ToolGrantStore,
} from "./ports";

// ── Cognitive Runtime port (Phase 11) ─────────────────────────────────────────

export type ToolProgressEvent =
  | { type: "accepted"; toolExecutionId: string }
  | { type: "approval_required"; toolExecutionId: string; approvalRequestId: string }
  | { type: "dispatched"; toolExecutionId: string; attempt: number }
  | { type: "settled"; toolExecutionId: string; status: ToolExecution["status"] };

export type ToolOutcome =
  | {
      kind: "succeeded";
      toolExecutionId: string;
      /** Live output on first execution; absent on an idempotent replay (never persisted). */
      output?: Record<string, JsonValue>;
      resultSummary?: Record<string, JsonValue>;
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

/** What the Cognitive Runtime depends on. It never sees credentials, grants or approvals internals. */
export interface ToolGatewayPort {
  execute(
    caller: ToolCaller,
    intent: unknown,
    opts?: { onProgress?: (e: ToolProgressEvent) => void },
  ): Promise<ToolOutcome>;
  inventory(caller: ToolCaller): Promise<ToolInventory>;
}

// ── Discovery (Phase 8) ───────────────────────────────────────────────────────

export interface ToolInventory {
  tenantId: string;
  connectors: {
    connectorId: string;
    category: ConnectorDefinition["category"];
    availability: ConnectorDefinition["availability"];
    /** `credentialRef` is the opaque handle only; the secret never leaves the resolver. */
    instances: {
      instanceId: string;
      status: ConnectorStatus;
      rateLimitedUntil?: string;
      credentialRef?: string;
    }[];
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
        /** The caller holds an explicit grant for exactly this action. */
        permitted: boolean;
        inputSchema: Record<string, JsonValue>;
      }[];
    }[];
  }[];
}

// ── Cockpit read contract (Phase 13) ─────────────────────────────────────────

export interface ToolCockpitSnapshot {
  connectorHealth: {
    instanceId: string;
    connectorId: string;
    status: ConnectorStatus;
    rateLimitedUntil?: string;
  }[];
  pendingApprovals: ToolApprovalRequest[];
  recentExecutions: ToolExecution[];
  failures: ToolExecution[];
  blocked: ToolExecution[];
  recentSideEffects: ToolExecution[];
  unsettled: ToolExecution[];
}

// ── Digital Workforce port (Phase 12) ────────────────────────────────────────

export interface ToolRequirement {
  toolId: string;
  action: ActionClass;
}
/** A role REQUIRES capabilities; it never grants them. `missing` must be granted explicitly. */
export interface CapabilityCoverage {
  granted: ToolRequirement[];
  missing: ToolRequirement[];
}

// ── Principals deciding approvals / grants (resolved by the caller from a session) ──

export type HumanPrincipal = { kind: "human"; id: string; roles: readonly Role[] };
export type AgentPrincipal = { kind: "agent"; id: string };

export interface ToolGatewayDeps {
  connectors: readonly Connector[];
  registry: ConnectorRegistry;
  agents: AgentLookup;
  grants: ToolGrantStore;
  executions: ToolExecutionStore;
  approvals: ToolApprovalStore;
  credentials: CredentialResolver;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** Extra wait beyond a tool's timeout before an EXECUTING row is considered orphaned. */
  orphanGraceMs?: number;
}

const MAX_SUMMARY_BYTES = 4096;

export class ToolGateway implements ToolGatewayPort {
  private readonly connectors: ReadonlyMap<string, Connector>;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly d: ToolGatewayDeps) {
    this.connectors = new Map(d.connectors.map((c) => [c.definition.connectorId, c]));
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? ((p) => `${p}-${randomUUID()}`);
  }

  // ── execute ────────────────────────────────────────────────────────────────

  async execute(
    caller: ToolCaller,
    rawIntent: unknown,
    opts: { onProgress?: (e: ToolProgressEvent) => void } = {},
  ): Promise<ToolOutcome> {
    const progress = opts.onProgress ?? (() => {});
    const parsed = toolIntentSchema.safeParse(rawIntent);
    if (!parsed.success) return fail("INVALID_INPUT", "invalid tool intent");
    const intent = parsed.data;
    const now = this.now();

    this.d.registry.rateLimitedUntilOf(intent.connectorInstanceId, now); // expire a lapsed provider limit
    const instance = this.d.registry.get(caller.tenantId, intent.connectorInstanceId);
    // Unknown and foreign instances look the same: no cross-tenant existence oracle.
    if (!instance) return fail("POLICY_DENIED", "connector instance not available to this tenant");
    const connector = this.connectors.get(instance.connectorId);
    const tool = connector?.definition.tools.find((t) => t.toolId === intent.toolId);
    const actionDef = tool && findAction(tool, intent.action);
    if (!connector || !tool || !actionDef) return fail("NOT_FOUND", "unknown tool or action");

    if (actionDef.idempotency === "key_required" && !intent.idempotencyKey) {
      return fail("INVALID_INPUT", "idempotencyKey is required for this side-effecting action");
    }
    const idempotencyKey = intent.idempotencyKey ?? `auto:${this.newId("k")}`;
    const fingerprint = requestFingerprint(caller, intent);

    let exec = await this.d.executions.getByKey(caller.tenantId, idempotencyKey);
    if (exec && exec.requestFingerprint !== fingerprint) {
      return fail("IDEMPOTENCY_CONFLICT", "idempotencyKey reused for a different request", exec);
    }
    if (exec) {
      const settled = await this.resumeExisting(exec, connector, tool, actionDef, instance);
      if (settled) return settled;
      exec = (await this.d.executions.getByKey(caller.tenantId, idempotencyKey))!;
    } else {
      const draft: ToolExecution = {
        toolExecutionId: this.newId("toolexec"),
        tenantId: caller.tenantId,
        idempotencyKey,
        requestFingerprint: fingerprint,
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
        if (exec.requestFingerprint !== fingerprint) {
          return fail(
            "IDEMPOTENCY_CONFLICT",
            "idempotencyKey reused for a different request",
            exec,
          );
        }
        const settled = await this.resumeExisting(exec, connector, tool, actionDef, instance);
        if (settled) return settled;
        exec = (await this.d.executions.getByKey(caller.tenantId, idempotencyKey))!;
      }
      progress({ type: "accepted", toolExecutionId: exec.toolExecutionId });
    }

    // Credential-shaped input is refused before any decision (Phase 6).
    if (containsSecret(intent.input)) {
      return this.settleDenied(
        exec,
        "INVALID_INPUT",
        "credential-shaped content is not accepted in tool input",
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

    if (decision.outcome === "approval_required") {
      let req = approvalReq && apState === "pending" ? approvalReq : null;
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
          status: "PENDING",
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
        };
        await this.d.approvals.create(
          req,
          this.audit(exec, "tool.approval.requested", { approvalRequestId: req.approvalRequestId }),
        );
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

    // ── allowed: local quota, credential, then dispatch exactly once ──
    const limited = this.d.registry.rateLimitedUntilOf(instance.instanceId, now);
    if (
      limited ||
      !this.d.registry.take(`${instance.instanceId}:${tool.toolId}`, tool.rateLimit, now)
    ) {
      return this.settleFailure(exec, "RATE_LIMIT", "NOT_APPLIED", "rate limit reached");
    }
    const credential = await this.resolveCredential(tool, instance, caller.tenantId);
    if (!credential.ok)
      return this.settleFailure(exec, credential.failureClass, "NOT_APPLIED", credential.message);

    return this.dispatch(
      exec,
      connector,
      tool,
      actionDef,
      instance,
      intent.input,
      credential.secret,
      progress,
    );
  }

  /** Terminal or in-flight rows are answered without re-dispatch. Returns null when re-decision is allowed. */
  private async resumeExisting(
    exec: ToolExecution,
    connector: Connector,
    tool: ToolDefinition,
    action: ToolActionDefinition,
    instance: ConnectorInstance,
  ): Promise<ToolOutcome | null> {
    const refs = exec.auditReferences;
    switch (exec.status) {
      case "SUCCEEDED":
        return {
          kind: "succeeded",
          toolExecutionId: exec.toolExecutionId,
          resultSummary: exec.resultSummary,
          replayed: true,
          auditReferences: refs,
        };
      case "REJECTED":
        return fail(
          "APPROVAL_REJECTED",
          "approval was rejected; this request will never execute",
          exec,
        );
      case "EXECUTING": {
        if (!this.isOrphaned(exec, tool))
          return {
            kind: "in_progress",
            toolExecutionId: exec.toolExecutionId,
            auditReferences: refs,
          };
        const r = await this.reconcileOne(exec, connector, action, instance);
        return r.status === "FAILED" && r.settlementState === "NOT_APPLIED" ? null : outcomeOf(r);
      }
      case "FAILED": {
        if (exec.settlementState === "UNKNOWN") {
          // Retry-sensitive and outcome unknown: only reconciliation may settle it.
          const r = await this.reconcileOne(exec, connector, action, instance);
          return r.status === "FAILED" &&
            r.settlementState === "NOT_APPLIED" &&
            TOOL_FAILURE_RETRYABLE[r.failureClass ?? "UNKNOWN"]
            ? null
            : outcomeOf(r);
        }
        return TOOL_FAILURE_RETRYABLE[exec.failureClass ?? "UNKNOWN"] ? null : outcomeOf(exec);
      }
      case "REQUESTED":
      case "DENIED":
      case "AWAITING_APPROVAL":
        return null;
      default:
        return fail("UNKNOWN", "unrecognised execution state", exec);
    }
  }

  private async dispatch(
    exec: ToolExecution,
    connector: Connector,
    tool: ToolDefinition,
    action: ToolActionDefinition,
    instance: ConnectorInstance,
    input: Record<string, JsonValue>,
    credential: SecretValue | undefined,
    progress: (e: ToolProgressEvent) => void,
  ): Promise<ToolOutcome> {
    const attempt = exec.attemptCount + 1;
    // The CAS below is the single point where a side effect is authorised: one winner per version.
    const dispatchAudit = this.audit(exec, "tool.execution.recorded", {
      phase: "dispatched",
      attempt,
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
    progress({ type: "dispatched", toolExecutionId: exec.toolExecutionId, attempt });

    const ctx: ConnectorContext = {
      instance,
      credential,
      signal: AbortSignal.timeout(tool.timeoutMs),
      idempotencyKey: exec.idempotencyKey,
      toolExecutionId: exec.toolExecutionId,
    };
    const result = await runWithTimeout(
      () => connector.execute(tool.toolId, action.action, input, ctx),
      tool.timeoutMs,
    );
    const now = this.now();

    let out: ToolOutcome;
    if (result.ok) {
      const output = credential ? scrub(result.output, credential.reveal()) : result.output;
      out = await this.transition(dispatched, {
        status: "SUCCEEDED",
        settlementState: "APPLIED",
        providerOperationId: result.providerOperationId,
        resultReference: result.resultReference,
        resultSummary:
          tool.auditPolicy.persistResult === "summary"
            ? safeSummary(result.summary, credential)
            : undefined,
        finishedAt: now.toISOString(),
      });
      if (out.kind === "succeeded") out = { ...out, output, replayed: false };
    } else {
      if (result.failureClass === "AUTH_FAILURE")
        this.d.registry.setStatus(instance.instanceId, "AUTH_FAILED");
      if (result.failureClass === "RATE_LIMIT") {
        this.d.registry.markRateLimited(instance.instanceId, now, result.retryAfterSeconds ?? 60);
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

  // ── reconciliation (restart / timeout) ─────────────────────────────────────

  /** Settle orphaned or unknown side effects of a tenant. Safe to run at boot and periodically. */
  async reconcile(tenantId: string): Promise<ToolExecution[]> {
    const rows = await this.d.executions.list(tenantId, {
      status: ["EXECUTING", "FAILED"],
      settlement: ["DISPATCHED", "UNKNOWN"],
      limit: 500,
    });
    const settled: ToolExecution[] = [];
    for (const row of rows) {
      const instance = this.d.registry.get(tenantId, row.connectorInstanceId);
      const connector = instance && this.connectors.get(instance.connectorId);
      const tool = connector?.definition.tools.find((t) => t.toolId === row.toolId);
      const action = tool && findAction(tool, row.action);
      if (!instance || !connector || !tool || !action) continue;
      if (row.status === "EXECUTING" && !this.isOrphaned(row, tool)) continue;
      settled.push(await this.reconcileOne(row, connector, action, instance));
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
            instance,
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
    const now = this.now().toISOString();
    const patch: Partial<ToolExecution> =
      outcome.settlement === "APPLIED"
        ? {
            status: "SUCCEEDED",
            settlementState: "APPLIED",
            providerOperationId: outcome.providerOperationId ?? exec.providerOperationId,
            resultSummary: safeSummary(outcome.summary, undefined),
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
    const req = await this.d.approvals.get(tenantId, approvalRequestId);
    if (!req)
      return { ok: false, failureClass: "NOT_FOUND", message: "approval request not found" };
    if (req.status !== "PENDING")
      return { ok: false, failureClass: "CONFLICT", message: "already decided" };
    const now = this.now();
    if (new Date(req.expiresAt) <= now)
      return { ok: false, failureClass: "APPROVAL_EXPIRED", message: "approval request expired" };
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
    if (approver.kind === "agent" && !(await this.resolveAgent(approver.id))) {
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

  // ── grants (admin) & Digital Workforce coverage ─────────────────────────────

  async setGrant(
    admin: HumanPrincipal,
    grant: Omit<ToolGrant, "grantedBy" | "grantedAt">,
    op: "grant" | "revoke",
  ): Promise<{ ok: boolean; message: string }> {
    // Same authority that assigns capabilities to agents (Lot C1): admin and above.
    if (!hasPermission(admin.roles, "agentCapabilities.write"))
      return { ok: false, message: "agentCapabilities.write required" };
    if (!this.actionOf(grant.toolId, grant.action))
      return { ok: false, message: "unknown tool action" };
    const audit = {
      ...this.baseAudit(
        grant.tenantId,
        { kind: "human" as const, id: admin.id },
        "tool.grant.changed",
      ),
      details: {
        tenantId: grant.tenantId,
        agentId: grant.agentId,
        toolId: grant.toolId,
        action: grant.action,
        op,
        expiresAt: grant.expiresAt ?? null,
      },
    };
    if (op === "revoke") return { ok: await this.d.grants.revoke(grant, audit), message: op };
    await this.d.grants.put(
      { ...grant, grantedBy: admin.id, grantedAt: this.now().toISOString() },
      audit,
    );
    return { ok: true, message: op };
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
      ).push({ ...r });
    }
    return coverage;
  }

  // ── discovery & cockpit ────────────────────────────────────────────────────

  async inventory(caller: ToolCaller): Promise<ToolInventory> {
    const now = this.now();
    const grants = await this.d.grants.listForAgent(caller.tenantId, caller.agentId);
    const instances = this.d.registry.list(caller.tenantId);
    return {
      tenantId: caller.tenantId,
      connectors: [...this.connectors.values()].map(({ definition: c }) => ({
        connectorId: c.connectorId,
        category: c.category,
        availability: c.availability,
        instances: instances
          .filter((i) => i.connectorId === c.connectorId)
          .map((i) => ({
            instanceId: i.instanceId,
            status: this.d.registry.rateLimitedUntilOf(i.instanceId, now)
              ? "RATE_LIMITED"
              : i.status,
            rateLimitedUntil: this.d.registry.rateLimitedUntilOf(i.instanceId, now)?.toISOString(),
            credentialRef: i.credential?.ref,
          })),
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
            permitted: grantCovers(grants, caller, t.toolId, a.action, now),
            inputSchema: a.inputSchema,
          })),
        })),
      })),
    };
  }

  async cockpitSnapshot(tenantId: string, limit = 50): Promise<ToolCockpitSnapshot> {
    const now = this.now();
    const recent = await this.d.executions.list(tenantId, { limit });
    return {
      connectorHealth: this.d.registry.list(tenantId).map((i) => ({
        instanceId: i.instanceId,
        connectorId: i.connectorId,
        status: i.status,
        rateLimitedUntil: this.d.registry.rateLimitedUntilOf(i.instanceId, now)?.toISOString(),
      })),
      pendingApprovals: await this.d.approvals.listPending(tenantId),
      recentExecutions: recent,
      failures: await this.d.executions.list(tenantId, { status: ["FAILED"], limit }),
      blocked: await this.d.executions.list(tenantId, { status: ["DENIED", "REJECTED"], limit }),
      recentSideEffects: (
        await this.d.executions.list(tenantId, { settlement: ["APPLIED"], limit })
      ).filter((e) => e.sideEffects !== "none"),
      unsettled: await this.d.executions.list(tenantId, {
        settlement: ["DISPATCHED", "UNKNOWN"],
        limit,
      }),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

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

  private async resolveCredential(
    tool: ToolDefinition,
    instance: ConnectorInstance,
    tenantId: string,
  ): Promise<
    | { ok: true; secret?: SecretValue }
    | { ok: false; failureClass: ToolFailureClass; message: string }
  > {
    if (!tool.credential?.required) return { ok: true };
    if (!instance.credential)
      return { ok: false, failureClass: "AUTH_FAILURE", message: "no credential configured" };
    const r = await this.d.credentials.resolve(instance.credential, tenantId);
    if (r.ok) return { ok: true, secret: r.secret };
    if (r.reason !== "tenant_mismatch")
      this.d.registry.setStatus(instance.instanceId, "AUTH_FAILED");
    return {
      ok: false,
      failureClass: r.reason === "tenant_mismatch" ? "POLICY_DENIED" : "AUTH_FAILURE",
      message: `credential ${instance.credential.ref}: ${r.reason}`,
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
    return outcomeOf(saved);
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

function outcomeOf(e: ToolExecution): ToolOutcome {
  switch (e.status) {
    case "SUCCEEDED":
      return {
        kind: "succeeded",
        toolExecutionId: e.toolExecutionId,
        resultSummary: e.resultSummary,
        replayed: true,
        auditReferences: e.auditReferences,
      };
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

/** Replace every occurrence of the secret in a JSON value (a connector echoing it must not leak it). */
function scrub<T extends JsonValue | Record<string, JsonValue>>(value: T, secret: string): T {
  if (!secret) return value;
  return JSON.parse(
    JSON.stringify(value).split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]"),
  ) as T;
}

function safeSummary(
  summary: Record<string, JsonValue> | undefined,
  credential: SecretValue | undefined,
): Record<string, JsonValue> | undefined {
  if (!summary) return undefined;
  const s = credential ? scrub(summary, credential.reveal()) : summary;
  if (containsSecret(s) || JSON.stringify(s).length > MAX_SUMMARY_BYTES) return { redacted: true };
  return s;
}
