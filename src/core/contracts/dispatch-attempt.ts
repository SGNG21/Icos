export type DispatchAttemptState =
  | "prepared"
  | "dispatched"
  | "completed"
  | "failed";

export interface DispatchAttempt {
  id: string;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  attempt: number;
  workflowId: string;
  prompt: string;
  workerKind?: string;
  capability?: string;
  state: DispatchAttemptState;
  createdAt: Date;
  updatedAt: Date;
  dispatchedAt?: Date;
  lastError?: string;
}

export interface PrepareDispatchAttemptResult {
  attempt: DispatchAttempt;

  /**
   * True only for the process which atomically created this durable
   * dispatch intent.
   *
   * False means the same logical attempt already existed and normal
   * execution must not repeat the external dispatch side effect.
   *
   * Crash recovery is handled separately through listPrepared().
   */
  acquired: boolean;
}

export interface PrepareDispatchAttemptInput {
  missionId: string;
  missionTaskId: string;
  taskId: string;
  attempt: number;
  workflowId: string;
  prompt: string;
  workerKind?: string;
  capability?: string;
}

export type AuthorizeDispatchStartResult =
  | { ok: true; task: import("@/core/contracts").Task; alreadyRunning: boolean }
  | {
      ok: false;
      reason:
        | "workflow_not_found"
        | "workflow_task_mismatch"
        | "attempt_not_eligible"
        | "stale_attempt"
        | "task_not_found"
        | "invalid_transition"
        | "audit_failed";
      message: string;
    };

export interface DispatchAttemptRepository {
  /**
   * Atomically:
   * - persists the dispatch intent
   * - moves the MissionTask to queued
   *
   * Replaying the same missionTaskId + attempt returns the existing attempt.
   */
  prepare(
    input: PrepareDispatchAttemptInput,
  ): Promise<PrepareDispatchAttemptResult>;

  /**
   * Atomically authorizes a started callback against the current authoritative
   * attempt and applies the canonical Task transition. Attempt authority cannot
   * change between validation and transition. A duplicate callback for the same
   * authoritative workflow returns `alreadyRunning: true`; stale/wrong/terminal
   * workflows fail closed.
   */
  authorizeStart(
    taskId: string,
    workflowId: string,
  ): Promise<AuthorizeDispatchStartResult>;

  /**
   * Atomically claims a PREPARED dispatch intent for crash recovery.
   *
   * Exactly one concurrent recoverer may hold a non-expired lease.
   * An expired lease may be acquired by a later recoverer.
   */
  claimPrepared(
    id: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean>;

  markDispatched(id: string): Promise<void>;

  markFailed(id: string, message: string): Promise<void>;

  markCompletedByWorkflowId(workflowId: string): Promise<void>;

  getByWorkflowId(workflowId: string): Promise<DispatchAttempt | null>;

  listPrepared(missionId?: string): Promise<DispatchAttempt[]>;

  /**
   * List all dispatch attempts for a given missionTaskId that are in a non-terminal state.
   * Non-terminal states are "prepared" and "dispatched".
   * Results are sorted by attempt number descending, then by createdAt descending.
   */
  listNonTerminalByMissionTaskId(missionTaskId: string): Promise<DispatchAttempt[]>;
}
