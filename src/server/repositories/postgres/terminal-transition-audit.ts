import { createHash } from "node:crypto";

import type { AuditActor, AuditEntry } from "@/core/contracts/audit";
import type { JsonValue } from "@/core/contracts/common";
import type { Database } from "@/server/database/client";
import { auditToRow } from "@/server/database/mappers";
import { auditEntries } from "@/server/database/schema";

/**
 * TERMINAL TRANSITIONS ARE AUDITED, EXACTLY ONCE (P0 traceability, W6 certification finding).
 *
 * A task or a mission reaches its terminal status through several durable paths — the
 * completion callback, the QC action, the integration settlement, the escalation, the mission
 * settlement, a control cancel. Most of them wrote the status with a bare UPDATE and no audit
 * row, so a mission that SUCCEEDED left no trace of having done so: the decision history
 * stopped at the last execution.
 *
 * Every one of those paths now writes ONE `task.transitioned` / `mission.transitioned` entry,
 * in the SAME transaction as the status it records, through this one builder.
 *
 * IDEMPOTENT BY CONSTRUCTION. The entry id is DERIVED from (entity, id, terminal status,
 * discriminator) instead of being random, and the insert is `ON CONFLICT DO NOTHING`: a replayed
 * callback, a repeated sweep or two racing settlers produce one row, never two. The
 * discriminator (the workflow of the attempt, when there is one) keeps a legitimately REPEATED
 * terminal outcome — a task re-dispatched after a success, then succeeding again — visible as a
 * second entry rather than folded into the first. Callers additionally write only when the
 * status ACTUALLY changed, so an unchanged re-write never audits at all.
 */

/** Terminal statuses of a canonical task (see `taskStatusSchema`). */
export const TERMINAL_TASK_AUDIT_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/** Terminal statuses of a mission (see `settleMission`): `blocked` is an escalation. */
export const TERMINAL_MISSION_AUDIT_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
]);

/**
 * The OUTCOME the trace reports. `escalated` is not a status of its own: an escalated task is
 * `failed` (QC escalation) and an escalated mission is `blocked` — the outcome says which.
 */
export type TerminalOutcome = "succeeded" | "failed" | "cancelled" | "escalated";

export const ICOS_SYSTEM_ACTOR: AuditActor = { kind: "system", id: "icos" };

function derivedId(
  kind: "task" | "mission",
  id: string,
  to: string,
  discriminator?: string,
): string {
  const digest = createHash("sha256")
    .update(`${kind}\u0000${id}\u0000${to}\u0000${discriminator ?? ""}`)
    .digest("hex")
    .slice(0, 40);
  return `audit-terminal-${kind}-${digest}`;
}

export interface TerminalTaskAuditInput {
  readonly taskId: string;
  readonly from: string;
  readonly to: string;
  /** Machine-readable cause, e.g. `EXECUTION_COMPLETED`, `QC_ACCEPT`, `QC_ESCALATED`. */
  readonly cause: string;
  readonly outcome?: TerminalOutcome;
  readonly workflowId?: string;
  readonly missionId?: string;
  readonly at?: Date;
  readonly actor?: AuditActor;
  readonly details?: Record<string, JsonValue>;
}

export function terminalTaskAuditEntry(input: TerminalTaskAuditInput): AuditEntry {
  const at = (input.at ?? new Date()).toISOString();
  return {
    id: derivedId("task", input.taskId, input.to, input.workflowId),
    occurredAt: at,
    createdAt: at,
    eventType: "task.transitioned",
    actor: input.actor ?? ICOS_SYSTEM_ACTOR,
    taskId: input.taskId,
    details: {
      ...(input.details ?? {}),
      from: input.from,
      to: input.to,
      terminal: true,
      outcome: input.outcome ?? (input.to as TerminalOutcome),
      cause: input.cause,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
    },
  };
}

export interface TerminalMissionAuditInput {
  readonly missionId: string;
  readonly from: string;
  readonly to: string;
  readonly cause: string;
  readonly goalId?: string | null;
  readonly at?: Date;
  readonly actor?: AuditActor;
}

export function terminalMissionAuditEntry(input: TerminalMissionAuditInput): AuditEntry {
  const at = (input.at ?? new Date()).toISOString();
  return {
    id: derivedId("mission", input.missionId, input.to),
    occurredAt: at,
    createdAt: at,
    eventType: "mission.transitioned",
    actor: input.actor ?? ICOS_SYSTEM_ACTOR,
    details: {
      missionId: input.missionId,
      from: input.from,
      to: input.to,
      terminal: true,
      outcome: input.to === "blocked" ? "escalated" : (input.to as TerminalOutcome),
      cause: input.cause,
      ...(input.goalId ? { goalId: input.goalId } : {}),
    },
  };
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Appends the entry unless an entry with the same derived id exists. `missionId` fills the
 * `audit_entries.mission_id` column so the trace reads a mission's entries by index, not by
 * scanning `details`.
 */
export async function appendTerminalAudit(
  executor: Database | Tx,
  entry: AuditEntry,
  missionId?: string | null,
): Promise<void> {
  await executor
    .insert(auditEntries)
    .values({ ...auditToRow(entry), missionId: missionId ?? null })
    .onConflictDoNothing({ target: auditEntries.id });
}
