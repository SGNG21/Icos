import { describe, expect, it } from "vitest";

import {
  decideExistingExecution,
  EXECUTION_IDENTITY_MEMO,
  type CanonicalExecutionIdentity,
  type ExistingExecutionFacts,
} from "./temporal-existing-execution";

/**
 * REUSE MUST BE EARNED.
 *
 * Temporal workflow ids are global and persistent, so `icos-task-<taskId>` may already be
 * held by an execution on another queue, of another type, of another task, of another
 * attempt, or one that finished long ago. The adapter used to answer every one of those
 * the same way — hand back the id and call it a dispatch — which is a false success in
 * each case. These tests fix the only answer that may ever be "yes".
 */

const IDENTITY: CanonicalExecutionIdentity = {
  taskId: "task-a",
  attempt: 2,
  missionId: "mission-a",
  taskQueue: "icos-tasks",
  workflowType: "runIcosTask",
};

function facts(overrides: Partial<ExistingExecutionFacts> = {}): ExistingExecutionFacts {
  return {
    status: "RUNNING",
    taskQueue: "icos-tasks",
    workflowType: "runIcosTask",
    memo: {
      [EXECUTION_IDENTITY_MEMO.taskId]: "task-a",
      [EXECUTION_IDENTITY_MEMO.attempt]: 2,
      [EXECUTION_IDENTITY_MEMO.missionId]: "mission-a",
    },
    ...overrides,
  };
}

describe("an OPEN execution is reused only when it is provably the same one", () => {
  it("OPEN_SAME_EXECUTION_REUSES: same task, attempt, type, queue and mission", () => {
    expect(decideExistingExecution(facts(), IDENTITY)).toEqual({ kind: "reuse" });
  });

  it("reuses an execution that continued as new under the same id", () => {
    expect(decideExistingExecution(facts({ status: "CONTINUED_AS_NEW" }), IDENTITY)).toEqual({
      kind: "reuse",
    });
  });

  it("OPEN_FOREIGN_QUEUE_FAILS_CLOSED: an execution on another task queue is not ours", () => {
    /*
     * The case the poller check cannot see: it proves a consumer on the queue we intend
     * to dispatch TO, while the execution actually holding the id sits on a queue no
     * worker of ours polls. Reusing it records the attempt dispatched for work that will
     * never run.
     */
    const verdict = decideExistingExecution(facts({ taskQueue: "someone-elses-queue" }), IDENTITY);

    expect(verdict).toEqual({ kind: "refuse", reason: "TEMPORAL_FOREIGN_TASK_QUEUE" });
  });

  it("refuses when the queue cannot be read at all", () => {
    expect(decideExistingExecution(facts({ taskQueue: undefined }), IDENTITY)).toEqual({
      kind: "refuse",
      reason: "TEMPORAL_EXISTING_QUEUE_UNKNOWN",
    });
  });

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: a different ICOS task holding the id", () => {
    const verdict = decideExistingExecution(
      facts({
        memo: {
          [EXECUTION_IDENTITY_MEMO.taskId]: "task-b",
          [EXECUTION_IDENTITY_MEMO.attempt]: 2,
        },
      }),
      IDENTITY,
    );

    expect(verdict).toEqual({ kind: "refuse", reason: "TEMPORAL_FOREIGN_TASK_IDENTITY" });
  });

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: a different ATTEMPT of the same task", () => {
    /*
     * The one that makes "same task" insufficient. Attempt 1 may still be running while
     * CORE3 has issued attempt 2; standing on attempt 1 would report attempt 2 dispatched
     * and let the reviewer judge the work of a run nobody asked to continue.
     */
    const verdict = decideExistingExecution(
      facts({
        memo: {
          [EXECUTION_IDENTITY_MEMO.taskId]: "task-a",
          [EXECUTION_IDENTITY_MEMO.attempt]: 1,
        },
      }),
      IDENTITY,
    );

    expect(verdict).toEqual({ kind: "refuse", reason: "TEMPORAL_FOREIGN_ATTEMPT_IDENTITY" });
  });

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: a different workflow type", () => {
    expect(decideExistingExecution(facts({ workflowType: "someOtherWorkflow" }), IDENTITY)).toEqual(
      { kind: "refuse", reason: "TEMPORAL_UNEXPECTED_WORKFLOW_TYPE" },
    );
  });

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: a different mission, where both state one", () => {
    expect(
      decideExistingExecution(
        facts({
          memo: {
            [EXECUTION_IDENTITY_MEMO.taskId]: "task-a",
            [EXECUTION_IDENTITY_MEMO.attempt]: 2,
            [EXECUTION_IDENTITY_MEMO.missionId]: "mission-z",
          },
        }),
        IDENTITY,
      ),
    ).toEqual({ kind: "refuse", reason: "TEMPORAL_FOREIGN_MISSION_IDENTITY" });
  });

  it("does not treat an absent mission on either side as a mismatch", () => {
    /* Mission-less dispatch is a legitimate caller shape, not a collision. */
    const noMissionOnTheWire = facts({
      memo: {
        [EXECUTION_IDENTITY_MEMO.taskId]: "task-a",
        [EXECUTION_IDENTITY_MEMO.attempt]: 2,
      },
    });

    expect(decideExistingExecution(noMissionOnTheWire, IDENTITY)).toEqual({ kind: "reuse" });
    expect(decideExistingExecution(facts(), { ...IDENTITY, missionId: undefined })).toEqual({
      kind: "reuse",
    });
  });
});

describe("an identity that cannot be PROVEN is refused, never assumed", () => {
  it("refuses an execution carrying no ICOS identity memo", () => {
    /*
     * Not started under this contract, so nothing about it can be established. Assuming a
     * match is exactly how a foreign execution came to be reported as a dispatch.
     */
    expect(decideExistingExecution(facts({ memo: undefined }), IDENTITY)).toEqual({
      kind: "refuse",
      reason: "TEMPORAL_EXISTING_IDENTITY_UNVERIFIABLE",
    });
  });

  it("refuses when the EXISTING execution states no attempt", () => {
    expect(
      decideExistingExecution(
        facts({ memo: { [EXECUTION_IDENTITY_MEMO.taskId]: "task-a" } }),
        IDENTITY,
      ),
    ).toEqual({ kind: "refuse", reason: "TEMPORAL_EXISTING_ATTEMPT_UNVERIFIABLE" });
  });

  it("refuses when the CALLER states no attempt", () => {
    /* A caller who cannot say which attempt this is cannot be told it is reusable. */
    expect(decideExistingExecution(facts(), { ...IDENTITY, attempt: undefined })).toEqual({
      kind: "refuse",
      reason: "TEMPORAL_EXISTING_ATTEMPT_UNVERIFIABLE",
    });
  });

  it("reads an attempt stamped as text rather than downgrading it to unverifiable", () => {
    const stringAttempt = facts({
      memo: {
        [EXECUTION_IDENTITY_MEMO.taskId]: "task-a",
        [EXECUTION_IDENTITY_MEMO.attempt]: "2",
        [EXECUTION_IDENTITY_MEMO.missionId]: "mission-a",
      },
    });

    expect(decideExistingExecution(stringAttempt, IDENTITY)).toEqual({ kind: "reuse" });
  });

  it("refuses a status it cannot interpret", () => {
    for (const status of ["UNSPECIFIED", "UNKNOWN", undefined, "SOMETHING_NEW"]) {
      expect(decideExistingExecution(facts({ status }), IDENTITY)).toEqual({
        kind: "refuse",
        reason: "TEMPORAL_EXISTING_STATUS_UNKNOWN",
      });
    }
  });

  it("refuses a PAUSED execution: open, but consuming nothing", () => {
    /*
     * Same canonical execution, so not a collision — but answering "reused" would record
     * the attempt dispatched while nothing progresses until somebody unpauses it.
     */
    expect(decideExistingExecution(facts({ status: "PAUSED" }), IDENTITY)).toEqual({
      kind: "refuse",
      reason: "TEMPORAL_EXISTING_WORKFLOW_PAUSED",
    });
  });
});

describe("a CLOSED execution is handed to ICOS, never answered by Temporal alone", () => {
  it.each(["COMPLETED", "FAILED", "CANCELLED", "CANCELED", "TIMED_OUT"])(
    "%s is closed and not terminated",
    (status) => {
      expect(decideExistingExecution(facts({ status }), IDENTITY)).toEqual({
        kind: "closed",
        terminated: false,
      });
    },
  );

  it("TERMINATED is distinguished, because it carries no ICOS callback", () => {
    /*
     * Termination does not run the workflow's own error path, so no failure is ever
     * reported and ICOS normally holds no terminal result. Keeping it distinct is what
     * lets the caller name the refusal correctly instead of implying a lost callback.
     */
    expect(decideExistingExecution(facts({ status: "TERMINATED" }), IDENTITY)).toEqual({
      kind: "closed",
      terminated: true,
    });
  });

  it("a closed execution of a FOREIGN identity is still a collision, not a reconciliation", () => {
    /* Identity is proven before status is even looked at. */
    const verdict = decideExistingExecution(
      facts({
        status: "COMPLETED",
        memo: {
          [EXECUTION_IDENTITY_MEMO.taskId]: "task-b",
          [EXECUTION_IDENTITY_MEMO.attempt]: 2,
        },
      }),
      IDENTITY,
    );

    expect(verdict).toEqual({ kind: "refuse", reason: "TEMPORAL_FOREIGN_TASK_IDENTITY" });
  });
});
