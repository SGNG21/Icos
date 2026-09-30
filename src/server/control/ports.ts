import type { AuditEntry } from "@/core/contracts";
import type { AuthenticatedSession } from "@/core/identity";
import type {
  CommandStatus,
  ControlCommandType,
  ControlTargetKind,
  ReauthStatus,
  RejectionCode,
  RiskClass,
  RuntimeFlags,
} from "@/core/control/contracts";
import type { ProofCheck } from "@/core/control/policy";
import type { Mission } from "@/core/mission/contracts";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

/** Durable control-plane state (decision 0055). Implemented in memory and in PostgreSQL. */

export interface CommandRecord {
  commandId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
  type: ControlCommandType;
  targetKind: ControlTargetKind;
  targetId: string;
  riskClass: RiskClass;
  reason: string;
  expectedVersion: number;
  /** ADMITTED = accepted, effect outcome not recorded yet. */
  status: CommandStatus | "ADMITTED";
  reauth: ReauthStatus;
  rejectionCode: RejectionCode | null;
  rejectionMessage: string | null;
  version: number | null;
  auditEntryId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ReauthProofRecord {
  id: string;
  tokenHash: string;
  userId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Operations available inside ONE command transaction. Implementations must
 * make the whole callback atomic and serialize transactions per command id.
 */
export interface ControlTx {
  getCommand(commandId: string): Promise<CommandRecord | null>;
  saveCommand(record: CommandRecord): Promise<void>;
  /** Locks the target's version row (creating it at 0) until commit; returns the version. */
  lockVersion(kind: ControlTargetKind, id: string): Promise<number>;
  setVersion(kind: ControlTargetKind, id: string, version: number): Promise<void>;
  isHeld(missionId: string): Promise<boolean>;
  setHold(missionId: string, commandId: string, at: string): Promise<void>;
  clearHold(missionId: string): Promise<void>;
  getFlags(): Promise<RuntimeFlags>;
  setFlags(flags: RuntimeFlags, commandId: string, at: string): Promise<void>;
  /** Checks a proof without consuming it. */
  checkProof(tokenHash: string, userId: string, sessionId: string, now: Date): Promise<ProofCheck>;
  /** Consumes a proof; false if it was consumed concurrently. */
  consumeProof(tokenHash: string, at: string): Promise<boolean>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

export interface ControlStore {
  transaction<T>(commandId: string, fn: (tx: ControlTx) => Promise<T>): Promise<T>;
  getCommand(commandId: string): Promise<CommandRecord | null>;
  /** Throws when the flags cannot be read: callers must fail closed. */
  readFlags(): Promise<RuntimeFlags>;
  /** Throws when holds cannot be read: callers must treat the mission as held. */
  isHeld(missionId: string): Promise<boolean>;
  readVersions(kind: ControlTargetKind, ids: readonly string[]): Promise<Map<string, number>>;
  listHeldMissionIds(): Promise<string[]>;
  insertReauthProof(record: ReauthProofRecord): Promise<void>;
}

/**
 * The canonical authorities the bus acts THROUGH. It never writes their state
 * itself: mission status goes through the mission repository and machine,
 * worker status through the worker registration service.
 */
export interface ControlEffects {
  readMission(id: string): Promise<Mission | null>;
  /** Operational-scope check (same model as the mission routes). */
  missionInScope(missionId: string, session: AuthenticatedSession): Promise<boolean>;
  /** Compare-and-set to `cancelled`; false when the status changed underneath. */
  cancelMission(id: string, from: Mission["status"]): Promise<boolean>;
  readWorker(id: string): Promise<WorkerRegistryEntry | null>;
  disableWorker(id: string): Promise<void>;
  /** Re-activates AND resets probe evidence: routes nothing until a real probe passes. */
  enableWorker(id: string): Promise<void>;
}
