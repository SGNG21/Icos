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
  /**
   * WHICH worker this attempt was assigned to (M5.3, defect 12).
   *
   * Durable attribution: it is what makes per-worker load countable, and what
   * gives reviewer independence a real producer identity. Absent on attempts
   * prepared before M5.3 and on paths that route no worker.
   */
  workerId?: string;
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
  /**
   * The worker this dispatch is assigned to (M5.3).
   *
   * When present, `prepare()` ALSO enforces that worker's declared concurrency
   * and its capacity pool INSIDE the same transaction that creates the intent.
   * The load-aware routing decision is made outside the transaction and is
   * therefore advisory: two supervisors can both read "worker W is free" and
   * both decide to use it. This is the guard that makes the outcome correct
   * anyway — it rejects with WORKER_CAPACITY_EXCEEDED rather than
   * oversubscribing.
   */
  workerId?: string;
  capability?: string;
}

/**
 * Thrown by `prepare()` when the assigned worker (or its capacity pool) is
 * already at its declared limit.
 *
 * A distinct error type because the caller's correct response is distinct: this
 * is not a failure of the task and not a corrupt state, it is back-pressure.
 * The task stays ready and is retried on a later tick, when capacity has freed.
 */
export class WorkerCapacityExceededError extends Error {
  constructor(
    readonly workerId: string,
    readonly detail: string,
  ) {
    super(`WORKER_CAPACITY_EXCEEDED: ${workerId} ${detail}`);
    this.name = "WorkerCapacityExceededError";
  }
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

  /**
   * Worker ids carried by every NON-TERMINAL attempt — one entry per active
   * execution, duplicates included (M5.3).
   *
   * This is the DURABLE load signal behind distribution. It is derived from the
   * same ledger that certifies exactly-once dispatch per task, so there is no
   * separate counter that could drift from it, and it reproduces identically
   * after a restart.
   */
  listActiveWorkerAssignments(): Promise<string[]>;
}
