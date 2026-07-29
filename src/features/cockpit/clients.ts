import type { MissionStatus } from "@/core/mission";

export const COCKPIT_JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
] as const;

export type CockpitJobStatus = (typeof COCKPIT_JOB_STATUSES)[number];
export type CockpitRequestKind = "CONVERSATION" | "MISSION";

export interface CockpitJobTask {
  taskId: string;
  label: string;
  status: CockpitJobStatus;
}

export interface CockpitJobFailure {
  code: string;
  message: string;
}

export interface CockpitJobProjection {
  jobId: string;
  missionId?: string;
  objective: string;
  status: CockpitJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  requestKind?: CockpitRequestKind;
  missionState?: string;
  planLabel?: string;
  tasks: readonly CockpitJobTask[];
  workers: readonly string[];
  blockers: readonly string[];
  evidence: readonly string[];
  sanitizedError?: CockpitJobFailure;
  finalResult?: string;
  mergePerformed: boolean;
  productionDeploymentPerformed: boolean;
}

export interface CockpitHttpClient {
  submitJob(
    objective: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CockpitJobProjection>;
  getJob(jobId: string, signal?: AbortSignal): Promise<CockpitJobProjection>;
}

export type MissionReadiness = "READY" | "NOT_READY";

export interface MissionEntrySnapshot {
  missionId: string;
  state: MissionStatus;
  readiness: MissionReadiness;
}

export interface MissionEntryClient {
  submit(objective: string): Promise<MissionEntrySnapshot>;
}

export type CapabilityPermissionState = "ALLOWED" | "APPROVAL_REQUIRED" | "DENIED" | "UNAVAILABLE";

export interface CapabilityViewSnapshot {
  capabilityId: string;
  available: boolean;
  permissionState: CapabilityPermissionState;
  scope: string;
  reason: string;
  constraints: readonly string[];
}

export interface CapabilitySnapshotClient {
  read(missionId?: string): Promise<readonly CapabilityViewSnapshot[]>;
}

export type SupervisorTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface SupervisorTaskSnapshot {
  taskId: string;
  label: string;
  status: SupervisorTaskStatus;
  dependsOn: readonly string[];
}

export interface SupervisorWorkerSnapshot {
  workerId: string;
  label: string;
  status: "running" | "passed" | "failed" | "blocked";
  taskIds: readonly string[];
}

export interface CockpitSupervisorSnapshot {
  missionId: string;
  objective: string;
  missionState: MissionStatus;
  planLabel?: string;
  tasks: readonly SupervisorTaskSnapshot[];
  workers: readonly SupervisorWorkerSnapshot[];
  blockers: readonly string[];
  errors: readonly string[];
  finalResult?: string;
  mergePerformed: boolean;
  productionDeploymentPerformed: boolean;
}

export interface SupervisorStateClient {
  read(missionId: string): Promise<CockpitSupervisorSnapshot>;
}
