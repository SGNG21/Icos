/**
 * WHAT DOES THIS WORKFLOW ID ALREADY REFER TO? — decided here, on facts alone.
 *
 * Temporal workflow ids are GLOBAL and PERSISTENT. `icos-task-<taskId>` is therefore not
 * a name this dispatch owns; it is a name that may already be taken, and taken by
 * something that has nothing to do with the execution being asked for:
 *
 *   - an execution on a DIFFERENT task queue (another deployment, another worker pool,
 *     a test run) — so no worker of ours will ever consume it;
 *   - an execution of a different workflow TYPE;
 *   - an execution of a different ICOS task, or of a different ATTEMPT of this task;
 *   - an execution that is already CLOSED, or was TERMINATED.
 *
 * The adapter used to answer all of these the same way: it asked Temporal to start with
 * `USE_EXISTING`, got a handle back, and returned it as a successful dispatch. For every
 * case above that is a FALSE SUCCESS — the attempt is recorded `dispatched`, nothing will
 * ever run it, and the only visible symptom arrives much later as a missing review.
 *
 * So reuse must be EARNED. This module is the proof step, and it is deliberately pure:
 * no client, no network, no clock. It takes what Temporal reported about the existing
 * execution plus the identity ICOS is asking for, and returns one of three verdicts.
 * Anything it cannot positively prove is a refusal — being unable to establish that two
 * executions are the same is not evidence that they are.
 */

/** Temporal statuses that mean the execution is still OPEN. */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "RUNNING",
  /* The execution carries on under the same workflowId. */
  "CONTINUED_AS_NEW",
]);

/**
 * Closed statuses, split by whether the closure can carry an ICOS callback at all.
 *
 * `TERMINATED` is separated because termination does not run the workflow's own error
 * path: no `reportFailure` is sent, so ICOS normally holds NO terminal result for it. A
 * terminated attempt must never be resurrected, and it must not be reported as a
 * successful dispatch either — it gets its own refusal code so an operator reading the
 * error knows which of the two happened.
 */
const TERMINATED_STATUS = "TERMINATED";
const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  /*
   * The SDK spells it `CANCELLED`; the protobuf enum and some server builds spell it
   * `CANCELED`. Both are the same closed execution, and reading one of them as "a status
   * this build does not know" would turn a cancelled attempt into a different refusal
   * code for no reason, so both are listed.
   */
  "CANCELLED",
  "CANCELED",
  "TIMED_OUT",
  TERMINATED_STATUS,
]);

/**
 * PAUSED is open but not progressing.
 *
 * It is still the same canonical execution, so it is not a collision — but a paused
 * workflow consumes nothing until somebody unpauses it, and answering a dispatch with
 * "reused" would record the attempt as dispatched and leave it there. It therefore gets
 * its own refusal rather than being folded into either side.
 */
const PAUSED_STATUS = "PAUSED";

/**
 * WHERE THE ICOS IDENTITY TRAVELS: the workflow's memo.
 *
 * It has to be somewhere `describe` returns, because the decision is made before any
 * history is read and the workflow arguments are not part of a description. The memo is
 * written once, by the dispatcher, at start — so a running execution carries the identity
 * of the attempt it was started for and cannot be made to claim another.
 *
 * Prefixed, because the memo namespace is shared with anything else a deployment chooses
 * to stamp on a workflow.
 */
export const EXECUTION_IDENTITY_MEMO = Object.freeze({
  taskId: "icosTaskId",
  attempt: "icosAttempt",
  missionId: "icosMissionId",
});

/** What Temporal reported about an execution that already holds the workflow id. */
export interface ExistingExecutionFacts {
  /** Temporal's status NAME, e.g. "RUNNING", "COMPLETED", "TERMINATED". */
  readonly status: string | undefined;
  readonly taskQueue: string | undefined;
  readonly workflowType: string | undefined;
  readonly memo: Readonly<Record<string, unknown>> | undefined;
}

/** The execution ICOS is asking for, as ICOS itself defines it. */
export interface CanonicalExecutionIdentity {
  readonly taskId: string;
  /** Issued by CORE3. Undefined means the caller cannot prove which attempt this is. */
  readonly attempt: number | undefined;
  readonly missionId: string | undefined;
  readonly taskQueue: string;
  readonly workflowType: string;
}

export type ExistingExecutionVerdict =
  /** Provably the same canonical execution, still open: idempotent reuse. */
  | { readonly kind: "reuse" }
  /**
   * Provably the same canonical execution, but finished. Whether this is a reconciliation
   * or a refusal depends on evidence this module cannot see: ICOS's own durable terminal
   * result. `terminated` distinguishes the closure so the caller can name it.
   */
  | { readonly kind: "closed"; readonly terminated: boolean }
  /** Not provably the same execution, or not usable. Never a successful dispatch. */
  | { readonly kind: "refuse"; readonly reason: string };

function refuse(reason: string): ExistingExecutionVerdict {
  return { kind: "refuse", reason };
}

function memoString(
  memo: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = memo?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function memoAttempt(
  memo: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = memo?.[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  /*
   * A memo value survives a payload round-trip, and a deployment that stamped the attempt
   * as text should not be read as "no attempt declared" — that would downgrade a
   * verifiable identity into an unverifiable one, which is the weaker answer.
   */
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Is the execution already holding this workflow id the SAME canonical ICOS execution?
 *
 * Checked in order of how cheaply a mismatch is explained, so the refusal reason names the
 * dimension that actually differs rather than the last one tested.
 */
export function decideExistingExecution(
  facts: ExistingExecutionFacts,
  identity: CanonicalExecutionIdentity,
): ExistingExecutionVerdict {
  /*
   * THE QUEUE FIRST. This is the dimension the previous consumer guard could not see: it
   * proved a poller on the queue we intended to dispatch TO, while `USE_EXISTING` could
   * hand back an execution sitting on an entirely different queue — provably consumable
   * by nobody we run.
   */
  if (!facts.taskQueue) return refuse("TEMPORAL_EXISTING_QUEUE_UNKNOWN");
  if (facts.taskQueue !== identity.taskQueue) return refuse("TEMPORAL_FOREIGN_TASK_QUEUE");

  if (!facts.workflowType) return refuse("TEMPORAL_EXISTING_TYPE_UNKNOWN");
  if (facts.workflowType !== identity.workflowType) {
    return refuse("TEMPORAL_UNEXPECTED_WORKFLOW_TYPE");
  }

  /*
   * THE ICOS IDENTITY. An execution with no identity memo was not started by this
   * contract, so nothing about it can be proven — and an unprovable identity is refused
   * rather than assumed to match, because assuming is precisely how a foreign execution
   * came to be reported as a successful dispatch.
   */
  const existingTaskId = memoString(facts.memo, EXECUTION_IDENTITY_MEMO.taskId);
  if (!existingTaskId) return refuse("TEMPORAL_EXISTING_IDENTITY_UNVERIFIABLE");
  if (existingTaskId !== identity.taskId) return refuse("TEMPORAL_FOREIGN_TASK_IDENTITY");

  const existingAttempt = memoAttempt(facts.memo, EXECUTION_IDENTITY_MEMO.attempt);
  if (existingAttempt === undefined || identity.attempt === undefined) {
    /*
     * One side cannot state its attempt. Reuse would then risk treating attempt N as
     * attempt N+1 — the same logical attempt executing twice, or a retry silently
     * inheriting a finished run.
     */
    return refuse("TEMPORAL_EXISTING_ATTEMPT_UNVERIFIABLE");
  }
  if (existingAttempt !== identity.attempt) return refuse("TEMPORAL_FOREIGN_ATTEMPT_IDENTITY");

  /*
   * The mission, where both sides state one. A task id is already unique, so a mission
   * mismatch means the two disagree about what they are part of; that is corruption, not
   * a reuse opportunity. Absent on either side is not a mismatch: mission-less dispatches
   * are a legitimate caller shape.
   */
  const existingMission = memoString(facts.memo, EXECUTION_IDENTITY_MEMO.missionId);
  if (
    identity.missionId !== undefined &&
    existingMission !== undefined &&
    existingMission !== identity.missionId
  ) {
    return refuse("TEMPORAL_FOREIGN_MISSION_IDENTITY");
  }

  /* Same canonical execution, proven. Now: is it still running? */
  const status = facts.status;
  if (!status) return refuse("TEMPORAL_EXISTING_STATUS_UNKNOWN");
  if (OPEN_STATUSES.has(status)) return { kind: "reuse" };
  if (status === PAUSED_STATUS) return refuse("TEMPORAL_EXISTING_WORKFLOW_PAUSED");
  if (CLOSED_STATUSES.has(status)) {
    return { kind: "closed", terminated: status === TERMINATED_STATUS };
  }
  /* UNSPECIFIED, UNKNOWN, or a status this build does not know: not a yes. */
  return refuse("TEMPORAL_EXISTING_STATUS_UNKNOWN");
}
