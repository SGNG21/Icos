/**
 * EXECUTION SCOPE — the client/project a piece of governed work belongs to (decision 0063,
 * amendment A).
 *
 * ONE SOURCE, CARRIED, NEVER RE-DECIDED. A conversation resolves the scope (decision 0063),
 * the launch writes it ONCE into the goal's metadata (`clientId` / `projectId` / `tenantId`),
 * and every later hop — the `start_mission` job, the mission and its tasks, the execution
 * grant a worker receives, the review request, the audit trail — carries that same value or
 * derives it from the goal through `missions.goal_id` / `tasks.goal_id`. Nothing downstream may
 * pick, widen or replace it: a hop that sees a scope different from the goal's REFUSES.
 *
 * Missions and tasks deliberately hold no scope column: they already hold the goal id, so a
 * copy there would be a second source that can drift. Pure module: no I/O.
 */
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity";

export interface ExecutionScope {
  readonly tenantId: string;
  /** Null = unscoped work (holding-level). Never "unknown": an unknown scope is refused. */
  readonly clientId: string | null;
  readonly projectId: string | null;
  readonly missionId: string;
  readonly taskId?: string;
  /** The goal the scope was read from; null for a generic mission with no goal. */
  readonly goalId: string | null;
  /** Provenance of the scope, carried for auditors (`cognitive_conversation`, …). */
  readonly policyContext?: Readonly<Record<string, string>>;
  /**
   * The widest durable data this execution may be given. `client` / `project`: that client's
   * (or project's) records only. `tenant`: unscoped work, which sees no client's records.
   */
  readonly allowedDataScope: "tenant" | "client" | "project";
}

/** The goal-metadata keys the launch writes and every hop reads. */
export const SCOPE_METADATA_KEYS = {
  tenantId: "tenantId",
  clientId: "clientId",
  projectId: "projectId",
} as const;

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/** The client/project pair a goal's metadata declares. */
export function scopeOfMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined): {
  readonly clientId: string | null;
  readonly projectId: string | null;
} {
  return {
    clientId: nonEmpty(metadata?.[SCOPE_METADATA_KEYS.clientId]),
    projectId: nonEmpty(metadata?.[SCOPE_METADATA_KEYS.projectId]),
  };
}

/**
 * The fields a job payload carries so the scope is visible at that hop. Omitted when absent:
 * an `undefined` in a jsonb payload would become a present-and-null key.
 */
export function scopePayloadFields(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): { clientId?: string; projectId?: string } {
  const { clientId, projectId } = scopeOfMetadata(metadata);
  return {
    ...(clientId ? { clientId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

export function executionScopeFromGoal(input: {
  readonly missionId: string;
  readonly taskId?: string;
  readonly goalId: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null | undefined;
}): ExecutionScope {
  const { clientId, projectId } = scopeOfMetadata(input.metadata);
  const source = nonEmpty(input.metadata?.source);
  return {
    tenantId: nonEmpty(input.metadata?.[SCOPE_METADATA_KEYS.tenantId]) ?? CURRENT_SINGLE_TENANT_ID,
    clientId,
    // A project without its client is not a usable scope (decision 0063): never carried alone.
    projectId: clientId ? projectId : null,
    missionId: input.missionId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    goalId: input.goalId,
    ...(source ? { policyContext: { source } } : {}),
    allowedDataScope: clientId ? (projectId ? "project" : "client") : "tenant",
  };
}

export type ScopeAgreement =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "EXECUTION_SCOPE_MISMATCH"; readonly field: string };

/**
 * FAIL CLOSED. Does what a hop was PRESENTED agree with the canonical scope?
 *
 * An ABSENT presented field is not a disagreement — older jobs and payloads predate the
 * carriage, and the canonical value then simply applies. A PRESENT field must be identical,
 * including a presented client on work whose goal has none: unscoped work must never be
 * relabelled as a client's.
 */
export function checkScopeAgreement(
  canonical: { readonly clientId: string | null; readonly projectId: string | null },
  presented: { readonly clientId?: unknown; readonly projectId?: unknown },
): ScopeAgreement {
  for (const field of ["clientId", "projectId"] as const) {
    const value = presented[field];
    if (value === undefined || value === null) continue;
    if (value !== canonical[field]) {
      return { ok: false, reason: "EXECUTION_SCOPE_MISMATCH", field };
    }
  }
  return { ok: true };
}

/** Raised by a hop that refuses work whose presented scope disagrees with its goal's. */
export class ExecutionScopeMismatchError extends Error {
  constructor(readonly field: string) {
    super(`EXECUTION_SCOPE_MISMATCH:${field}`);
    this.name = "ExecutionScopeMismatchError";
  }
}

/** Audit-entry details for a mission/task event: ids only, never client knowledge. */
export function scopeAuditDetails(scope: Pick<ExecutionScope, "clientId" | "projectId"> | null): {
  clientId?: string;
  projectId?: string;
} {
  if (!scope?.clientId) return {};
  return {
    clientId: scope.clientId,
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
  };
}
