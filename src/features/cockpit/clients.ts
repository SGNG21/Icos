import type { MissionStatus } from "@/core/mission";

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
