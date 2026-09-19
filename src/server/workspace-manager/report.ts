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
