import { randomUUID } from "node:crypto";

import type { AuditRepository } from "@/server/repositories/ports";

import type { ScopeStatus } from "./scope";
import type { IntegrationDecision } from "./types";

export type StepStatus = "PASS" | "FAIL" | "SKIPPED";
export type ConflictStatus = "CLEAN" | "BEHIND" | "CONFLICT" | "MULTI_WORKER" | "SKIPPED";

export interface IntegrationReport {
  workspaceId: string;
  workerId: string;
  branch: string;
  worktree: string;
  baseCommit: string;
  targetCommit: string;
  testDatabase: string;
  fileScopeStatus: ScopeStatus | "SKIPPED";
  sharedFilesChanged: string[];
  migrations: string[];
  typecheck: StepStatus;
  lint: StepStatus;
  unitTests: StepStatus;
  postgresTests: StepStatus;
  build: StepStatus;
  secretCheck: StepStatus;
  conflictStatus: ConflictStatus;
  conflictFiles: string[];
  decision: IntegrationDecision;
  commitSha: string;
  reasons: string[];
}

const list = (items: readonly string[]) => (items.length ? items.join(",") : "NONE");

/** Format texte stable, une clé par ligne ; `REASONS` en dernier (jamais de valeur secrète). */
export function formatReport(r: IntegrationReport): string {
  return [
    `WORKSPACE_ID=${r.workspaceId}`,
    `WORKER_ID=${r.workerId}`,
    `BRANCH=${r.branch}`,
    `WORKTREE=${r.worktree}`,
    `BASE_COMMIT=${r.baseCommit}`,
    `TARGET_COMMIT=${r.targetCommit}`,
    `TEST_DATABASE=${r.testDatabase}`,
    `FILE_SCOPE_STATUS=${r.fileScopeStatus}`,
    `SHARED_FILES_CHANGED=${list(r.sharedFilesChanged)}`,
    `MIGRATIONS=${list(r.migrations)}`,
    `TYPECHECK=${r.typecheck}`,
    `LINT=${r.lint}`,
    `UNIT_TESTS=${r.unitTests}`,
    `POSTGRES_TESTS=${r.postgresTests}`,
    `BUILD=${r.build}`,
    `SECRET_CHECK=${r.secretCheck}`,
    `CONFLICT_STATUS=${r.conflictStatus}`,
    `INTEGRATION_DECISION=${r.decision}`,
    `COMMIT_SHA=${r.commitSha}`,
    `REASONS=${r.reasons.length ? r.reasons.join(" | ").replace(/\n/g, " ") : "NONE"}`,
  ].join("\n");
}

/** Audit event under which every gate report is durably recorded (migration 0063). */
export const GATE_REPORT_EVENT = "workspace.gate.reported" as const;

export interface GateReportContext {
  missionId: string | null;
  taskId: string | null;
}

/** Durable sink for gate reports. The gate records BEFORE it transitions the workspace. */
export interface GateReportRecorder {
  record(report: IntegrationReport, context: GateReportContext): Promise<void>;
}

/**
 * Gate reports in the append-only audit journal (`audit_entries`, protected by trigger
 * against UPDATE/DELETE). The report holds no secret by construction: step outputs reach it
 * only as a truncated tail, and the PostgreSQL step's only credential — its per-run password —
 * is redacted by the gate before that (and dies with the run). `taskId`/`missionId` go into
 * `details`, not the FK columns: a workspace may be manual, with no task row.
 */
export class AuditGateReportRecorder implements GateReportRecorder {
  constructor(
    private readonly audit: Pick<AuditRepository, "append">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(report: IntegrationReport, context: GateReportContext): Promise<void> {
    const at = this.now().toISOString();
    await this.audit.append({
      id: `gate-report-${randomUUID()}`,
      eventType: GATE_REPORT_EVENT,
      actor: { kind: "system", id: "integration-gate" },
      details: {
        formatVersion: 1,
        missionId: context.missionId,
        taskId: context.taskId,
        report: JSON.parse(JSON.stringify(report)),
      },
      occurredAt: at,
      createdAt: at,
    });
  }
}
