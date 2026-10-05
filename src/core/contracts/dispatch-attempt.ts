import type { WorkerFailureClass } from "./worker-execution";

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
  /**
   * How this attempt failed, operationally (M6.3, migration 0046).
   *
   * Finer than the business `error_code` on purpose: it is the input to the retry
   * decision, and `WORKER_FAILED` cannot distinguish a throttled provider from an
   * impossible task.
   */
  failureClass?: WorkerFailureClass;
  /** The worker's own session handle, so the NEXT attempt continues this task. */
  resumeToken?: string;
  /** What this attempt had already accomplished when it stopped. */
  handoff?: Record<string, unknown>;
  /**
   * ROUTING_DECISION evidence (decision 0054, migration 0048): why this compute, written with
   * the attempt and never changed. Absent on attempts routed before 0054 or not routed.
   */
  routingDecision?: Record<string, unknown>;
  /** What the worker process actually took, when observed. */
  executionDurationMs?: number;
}

/**
 * The state the next attempt inherits so it CONTINUES rather than restarts.
 *
 * `attempt` is the attempt this came from — carried so a resume can prove which
 * logical predecessor it is continuing.
 */
export interface ResumableAttemptState {
  attempt: number;
  resumeToken?: string;
  handoff?: Record<string, unknown>;
  failureClass?: WorkerFailureClass;
}

export interface RecordExecutionFailureInput {
  failureClass: WorkerFailureClass;
  message: string;
  /** What the worker process took, when a process ran. Feeds routing history. */
  durationMs?: number;
  resumeToken?: string;
  handoff?: Record<string, unknown>;
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
  /** ROUTING_DECISION evidence, persisted in the same transaction as the intent (0054). */
  routingDecision?: Record<string, unknown>;
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

/** Who owns a dispatched execution, and for how long. Both required. */
export interface ExecutionLeaseGrant {
  readonly owner: string;
  readonly leaseMs: number;
}

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

  /**
   * Gives back a claim this owner holds on a still-PREPARED intent, so the next wake-up can
   * claim it at once instead of waiting out the lease. Only the holder's token releases it.
   */
  releaseClaim(id: string, ownerToken: string): Promise<void>;

  /**
   * DISPATCHED implies a FINITE LEASE, in one atomic write.
   *
   * An attempt used to enter `dispatched` with a null lease, and nothing could ever
   * reclaim it: `listAbandonedExecutions` needs an expiry to call a runner dead, and the
   * orphan scan can only ask a workflow probe — which answers "running" for ever when a
   * workflow sits on a task queue no worker consumes. Nineteen such rows each pinned a
   * worker of concurrency 1 until no capacity was left.
   *
   * The lease is therefore part of the transition rather than a later call a caller may
   * forget, and it is REQUIRED so that forgetting it does not typecheck.
   */
  markDispatched(id: string, lease: ExecutionLeaseGrant): Promise<void>;

  markFailed(id: string, message: string): Promise<void>;

  /**
   * Settles an attempt as failed WITH its operational classification and whatever
   * resume state the worker produced (M6.3).
   *
   * Distinct from `markFailed` rather than an optional argument on it, because the
   * pre-existing callers (recovery, dispatch errors) have no classification to give
   * and must not be forced to invent one. A caller that knows uses this; a caller
   * that does not keeps recording an unclassified failure, which stays honest.
   */
  recordExecutionFailure(id: string, input: RecordExecutionFailureInput): Promise<void>;

  /**
   * Acquires the EXECUTION lease on a dispatched attempt.
   *
   * True only for the single owner. An expired lease may be taken over — that is
   * what makes an abandoned execution recoverable instead of permanently stuck.
   * Deliberately separate from `claimPrepared`, which fences recovery dispatch of a
   * PREPARED attempt: see migration 0046 for why sharing the columns is unsafe.
   */
  acquireExecutionLease(id: string, owner: string, leaseMs: number): Promise<boolean>;

  /**
   * THE FENCE. False when this owner no longer holds a live lease on the attempt.
   *
   * Asked after a worker process ends and before its result is reported: a runner
   * whose lease expired mid-run must not report anything, because another runner may
   * already have redone the work, and two results for one logical attempt is a
   * duplicate integration.
   */
  holdsExecutionLease(id: string, owner: string): Promise<boolean>;

  /**
   * The resume state the NEXT attempt for this mission task should inherit, from
   * the most recent attempt that recorded any. Null when there is nothing to
   * continue, which is the normal first-attempt case.
   */
  latestResumableState(missionTaskId: string): Promise<ResumableAttemptState | null>;

  /** `durationMs`: what the worker process took, when a process ran (routing history, 0054). */
  markCompletedByWorkflowId(workflowId: string, durationMs?: number): Promise<void>;

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

  /**
   * Mission task ids that still carry a `prepared` or `dispatched` attempt.
   *
   * Evidence for mission settlement, returned as ids rather than a count so the caller
   * can weigh each against the task it belongs to: an attempt left over on a task that
   * has already reached a terminal status is stale bookkeeping for the reaper, not an
   * execution that could still change the outcome, and treating it as live strands the
   * mission for ever — which is the very failure settlement exists to end.
   *
   * Deliberately a first-class method. The guard that preceded it called
   * `listByMissionId?.()`, a method this repository has never had, so optional chaining
   * answered `undefined` and the check passed without asking the database.
   */
  listActiveMissionTaskIds(missionId: string): Promise<string[]>;
}
