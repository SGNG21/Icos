import { createHash } from "node:crypto";

import { decideExecution } from "@/core/authorization/decide";
import type { Agent, ApprovalStatus, RiskLevel } from "@/core/contracts";

import {
  DISPATCHABLE_STATUSES,
  RISK_ORDER,
  RETRY_SENSITIVE_ACTIONS,
  type ApprovalRequirement,
  type ConnectorDefinition,
  type ConnectorHealthRecord,
  type ConnectorInstance,
  type ConnectorStatus,
  type DuplicatePolicy,
  type RiskClass,
  type ToolActionDefinition,
  type ToolApprovalRequest,
  type ToolCaller,
  type ToolFailureClass,
  type ToolGrant,
  type ToolIntent,
} from "./model";

/** Tool risk → kernel risk. HIGH and CRITICAL are `sensitive`: human approval always required. */
const KERNEL_RISK: Readonly<Record<RiskClass, RiskLevel>> = {
  LOW: "read_only",
  MEDIUM: "reversible",
  HIGH: "sensitive",
  CRITICAL: "sensitive",
};

/**
 * Policy floor on top of the declared requirement: HIGH and CRITICAL always
 * need a HUMAN approval (kernel: `sensitive` needs explicit human approval), so
 * no agent — requester or not — can approve them. A definition can only make
 * approval stricter, never looser.
 */
export function effectiveApproval(a: ToolActionDefinition): ApprovalRequirement {
  if (RISK_ORDER[a.risk] >= RISK_ORDER.HIGH) {
    return { ...a.approval, mode: "human", selfApprovalAllowed: false };
  }
  return a.approval;
}

/** A grant is exact: this tenant, this agent, this tool, this action, not expired, not revoked. */
export function grantCovers(
  grants: readonly ToolGrant[],
  caller: ToolCaller,
  toolId: string,
  action: ToolActionDefinition["action"],
  now: Date,
): boolean {
  return grants.some(
    (g) =>
      g.tenantId === caller.tenantId &&
      g.agentId === caller.agentId &&
      g.toolId === toolId &&
      g.action === action &&
      g.revokedAt === undefined &&
      (g.expiresAt === undefined || new Date(g.expiresAt) > now),
  );
}

export type ApprovalState = "none" | "pending" | "approved" | "rejected" | "expired";

export function approvalState(
  req: ToolApprovalRequest | undefined,
  fingerprint: string,
  now: Date,
): ApprovalState {
  if (!req) return "none";
  // Bound to the exact request: a different payload is not approved.
  if (req.requestFingerprint !== fingerprint) return "none";
  if (req.status === "REJECTED") return "rejected";
  // Single use: a dispatched approval never authorises another dispatch.
  if (req.consumedAt !== undefined) return "none";
  if (new Date(req.expiresAt) <= now) return "expired";
  return req.status === "APPROVED" ? "approved" : "pending";
}

export type ToolPolicyDecision =
  | { outcome: "allow" }
  | { outcome: "approval_required" }
  | { outcome: "deny"; failureClass: ToolFailureClass; reason: string };

export interface ToolPolicyInput {
  caller: ToolCaller;
  /** Resolved server-side from `caller.agentId`; null → deny. */
  agent: Agent | null;
  connector: ConnectorDefinition;
  instance: ConnectorInstance;
  /** Effective live status from dated health evidence (`effectiveConnectorStatus`). */
  status: ConnectorStatus;
  toolId: string;
  action: ToolActionDefinition;
  grants: readonly ToolGrant[];
  approval: ApprovalState;
  now: Date;
}

const deny = (failureClass: ToolFailureClass, reason: string): ToolPolicyDecision => ({
  outcome: "deny",
  failureClass,
  reason,
});

/**
 * THE tool authorization decision. Order: tenant → connector availability →
 * explicit grant → kernel authorization floor (`decideExecution`) → approval.
 * Anything unrecognised is a deny: no path defaults to allow.
 */
export function decideToolRequest(p: ToolPolicyInput): ToolPolicyDecision {
  if (p.instance.tenantId !== p.caller.tenantId) {
    return deny("POLICY_DENIED", "connector instance belongs to another tenant");
  }
  if (p.connector.connectorId !== p.instance.connectorId) {
    return deny("POLICY_DENIED", "instance/connector mismatch");
  }
  if (p.connector.availability !== "CONNECTED") {
    return deny("NOT_CONNECTED", `connector ${p.connector.connectorId} is not connected`);
  }
  if (!DISPATCHABLE_STATUSES.has(p.status)) {
    const cls: ToolFailureClass =
      p.status === "AUTH_FAILED"
        ? "AUTH_FAILURE"
        : p.status === "RATE_LIMITED"
          ? "RATE_LIMIT"
          : "PROVIDER_UNAVAILABLE";
    return deny(cls, `connector instance status ${p.status}`);
  }
  if (!p.agent) return deny("PERMISSION_DENIED", "unknown requester agent");
  if (!grantCovers(p.grants, p.caller, p.toolId, p.action.action, p.now)) {
    return deny("PERMISSION_DENIED", `no grant for ${p.toolId}:${p.action.action}`);
  }

  const req = effectiveApproval(p.action);
  if (p.approval === "rejected") return deny("APPROVAL_REJECTED", "approval rejected");
  if (req.mode !== "none" && p.approval === "expired") {
    return deny("APPROVAL_EXPIRED", "approval expired");
  }

  const approvalStatus: ApprovalStatus =
    req.mode === "none" ? "not_required" : p.approval === "approved" ? "approved" : "pending";
  const kernel = decideExecution(
    {
      id: "tool-action",
      initiatedByAgentId: p.agent.id,
      kind: `tool:${p.toolId}:${p.action.action}`,
      risk: KERNEL_RISK[p.action.risk],
      requiresHumanApproval: req.mode !== "none",
      approvalStatus,
      requestedAt: p.now.toISOString(),
    },
    p.agent,
  );
  switch (kernel.outcome) {
    case "allowed":
      return { outcome: "allow" };
    case "awaiting_approval":
      return { outcome: "approval_required" };
    case "refused":
      return kernel.reason === "approval_rejected"
        ? deny("APPROVAL_REJECTED", "approval rejected")
        : deny("PERMISSION_DENIED", `kernel authorization: ${kernel.reason}`);
    default:
      return deny("UNKNOWN", "unrecognised kernel decision");
  }
}

/** May `approver` decide this request? Humans need `approvals.decide` (checked by the caller). */
export function canDecideApproval(
  action: ToolActionDefinition,
  request: ToolApprovalRequest,
  approver: { kind: "human" | "agent"; id: string },
): boolean {
  const req = effectiveApproval(action);
  if (req.mode === "none") return false;
  if (approver.kind === "human") return true;
  if (req.mode !== "human_or_agent") return false;
  return approver.id !== request.requesterAgentId || req.selfApprovalAllowed;
}

/** Canonical JSON (sorted keys) so equal requests hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

/** Binds an idempotency key and an approval to ONE requester and ONE exact request. */
export function requestFingerprint(caller: ToolCaller, intent: ToolIntent): string {
  return sha256({
    tenantId: caller.tenantId,
    agentId: caller.agentId,
    toolId: intent.toolId,
    action: intent.action,
    connectorInstanceId: intent.connectorInstanceId,
    input: intent.input,
    // Approving a knowing repeat is a different decision from approving a first send.
    duplicateOf: intent.duplicateOverride?.ofExecutionId ?? null,
  });
}

/** The operation itself, whoever requests it and under whatever key: duplicate detection. */
export function operationFingerprint(tenantId: string, intent: ToolIntent): string {
  return sha256({
    tenantId,
    toolId: intent.toolId,
    action: intent.action,
    connectorInstanceId: intent.connectorInstanceId,
    input: intent.input,
  });
}

export const DEFAULT_DUPLICATE_WINDOW_SECONDS = 24 * 3600;

/**
 * Deployment override (`toolId:ACTION`) > definition > default. The default
 * protects retry-sensitive classes that change something; everything else may
 * legitimately repeat.
 */
export function effectiveDuplicatePolicy(
  toolId: string,
  action: ToolActionDefinition,
  overrides: Readonly<Record<string, DuplicatePolicy>> = {},
): DuplicatePolicy {
  const configured = overrides[`${toolId}:${action.action}`] ?? action.duplicatePolicy;
  if (configured) return configured;
  return RETRY_SENSITIVE_ACTIONS.has(action.action) && action.sideEffects !== "none"
    ? { mode: "require_override", windowSeconds: DEFAULT_DUPLICATE_WINDOW_SECONDS }
    : { mode: "allow", windowSeconds: 0 };
}

/**
 * Live status of an instance from dated evidence. Never optimistic: no
 * evidence or stale evidence is UNKNOWN (fail closed), a disabled instance is
 * DISABLED whatever its last probe said.
 */
export function effectiveConnectorStatus(
  instance: ConnectorInstance,
  record: ConnectorHealthRecord | null,
  now: Date,
): ConnectorStatus {
  if (!instance.enabled) return "DISABLED";
  if (!record || new Date(record.expiresAt) <= now) return "UNKNOWN";
  if (record.rateLimitedUntil && new Date(record.rateLimitedUntil) > now) return "RATE_LIMITED";
  // A lapsed throttle says nothing about health: only a new probe does.
  if (record.status === "RATE_LIMITED") return "UNKNOWN";
  return record.status;
}
