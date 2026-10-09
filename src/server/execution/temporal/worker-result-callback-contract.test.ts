import { describe, expect, it } from "vitest";

import { workerKindSchema } from "@/core/contracts/task-execution";
import { executionCompletedBodySchema } from "@/server/http/execution-schemas";

import { firstLineRedacted } from "@/server/workers/probes/probe-redaction";

import { causeMessages, failureCodeOf, reportableWorkerKind } from "./worker-run";

/**
 * THE TWO SIDES OF THE COMPLETION CALLBACK, HELD TOGETHER.
 *
 * The workflow builds a completion payload; the route VALIDATES it and rejects an invalid
 * one with HTTP 400. Nothing coupled the two, so they drifted — and the drift was silent
 * in the worst possible way.
 *
 * Generalising the result contract beyond hermes correctly stopped the workflow asserting
 * `workerKind: "hermes"`. But `workerKind` is a CLOSED enum the route validates, and the
 * generalisation put the observed executor there (a filesystem path, on success) and the
 * literal `"unknown"` there (on failure). Both are outside the set, so EVERY completion
 * callback — success and failure alike — came back 400.
 *
 * What that looks like from the outside is the defect this whole lane exists to remove:
 * the dispatch succeeds, the worker runs and reports, ICOS refuses the report, Temporal
 * retries twenty times and gives up, and the attempt sits at `dispatched` for ever. No
 * result, no quality-control job, the reviewer never asked, and a missing review as the
 * only symptom — which is exactly how an entire integration family came to hang.
 *
 * A unit test of either side alone would have passed. So these tests assert the payloads
 * the workflow can actually produce against the schema that actually guards the route.
 */

const IDENTIFIERS = {
  taskId: "d36-85u329100de-c1-a",
  workflowId: "icos-task-d36-85u329100de-c1-a",
  startedAt: "2026-10-05T12:00:00.000Z",
  completedAt: "2026-10-05T12:03:00.000Z",
};

/** Exactly what `runIcosTask` sends on the success path. */
function successPayload(routedKind: string | undefined, actualExecutor: string) {
  return {
    ...IDENTIFIERS,
    outcome: "success",
    workerKind: reportableWorkerKind(routedKind),
    result: "wrote src/task/feature.txt",
    actualExecutor,
  };
}

/** Exactly what `runIcosTask` sends on the failure path. */
function failurePayload(routedKind: string | undefined, message: string) {
  return {
    ...IDENTIFIERS,
    outcome: "failure",
    workerKind: reportableWorkerKind(routedKind),
    error: { code: failureCodeOf([message]), message },
  };
}

describe("reportableWorkerKind", () => {
  it("passes through every kind the callback contract accepts", () => {
    for (const kind of workerKindSchema.options) {
      expect(reportableWorkerKind(kind)).toBe(kind);
    }
  });

  it("answers `other` for anything the contract would reject", () => {
    /*
     * The two values that actually shipped: a filesystem path (the observed executor, on
     * the success path) and the literal "unknown" (on the failure path).
     */
    for (const routed of [undefined, "", "unknown", "/usr/local/bin/node", "node", "codex"]) {
      expect(reportableWorkerKind(routed)).toBe("other");
    }
  });

  it("never answers with a value the callback contract rejects", () => {
    const hostile = [
      undefined,
      "",
      " hermes",
      "HERMES",
      "hermes ",
      "unknown",
      process.execPath,
      "a".repeat(500),
      "../../etc/passwd",
    ];

    for (const routed of hostile) {
      expect(workerKindSchema.safeParse(reportableWorkerKind(routed)).success).toBe(true);
    }
  });
});

describe("every completion payload the workflow can build is ACCEPTED", () => {
  it("accepts a success reported for an executor that is not a named kind", () => {
    /*
     * The regression, exactly. `actualExecutor` is where the real executable belongs —
     * free-form, up to 200 characters — and it keeps carrying it.
     */
    const parsed = executionCompletedBodySchema.safeParse(
      successPayload(undefined, "/usr/local/bin/node"),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.workerKind).toBe("other");
    expect(parsed.success && parsed.data.actualExecutor).toBe("/usr/local/bin/node");
  });

  it("accepts a failure raised before the run ever resolved an executor", () => {
    const parsed = executionCompletedBodySchema.safeParse(
      failurePayload(undefined, "WORKER_WORKSPACE_ROOT_UNREADABLE: racine déclarée introuvable"),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.workerKind).toBe("other");
  });

  it("accepts success and failure for every routed kind, and for no routed kind", () => {
    for (const routed of [...workerKindSchema.options, undefined, "unknown", process.execPath]) {
      expect(
        executionCompletedBodySchema.safeParse(successPayload(routed, process.execPath)).success,
      ).toBe(true);
      expect(
        executionCompletedBodySchema.safeParse(failurePayload(routed, "WORKER_TIMEOUT")).success,
      ).toBe(true);
    }
  });

  it("still refuses an implied success: a failure must carry a normalised error", () => {
    /*
     * The fail-closed property must survive the fix. Widening `workerKind` to accept
     * anything would have made these payloads valid too, which is why the kind is mapped
     * rather than the schema relaxed.
     */
    const { error: _dropped, ...failureWithoutError } = failurePayload(undefined, "boom");

    expect(executionCompletedBodySchema.safeParse(failureWithoutError).success).toBe(false);
    expect(
      executionCompletedBodySchema.safeParse({
        ...successPayload(undefined, "node"),
        error: { code: "WORKER_FAILED", message: "boom" },
      }).success,
    ).toBe(false);
  });

  it("documents what the OLD payloads did, so the regression cannot return quietly", () => {
    /* Both of these are what shipped, and both were rejected with HTTP 400. */
    expect(
      executionCompletedBodySchema.safeParse({
        ...IDENTIFIERS,
        outcome: "success",
        workerKind: "/usr/local/bin/node",
        result: "wrote src/task/feature.txt",
        actualExecutor: "/usr/local/bin/node",
      }).success,
    ).toBe(false);
    expect(
      executionCompletedBodySchema.safeParse({
        ...IDENTIFIERS,
        outcome: "failure",
        workerKind: "unknown",
        error: { code: "WORKER_FAILED", message: "boom" },
      }).success,
    ).toBe(false);
  });
});

/**
 * THE FAILURE CODE IS EVIDENCE, AND SOMETHING DECIDES ON IT.
 *
 * This side built `code: "WORKER_FAILED"` for every cause. The canonical review's hard rule
 * reads that code to decide whether a failed execution may be RE-EXECUTED (RETRY) or must be
 * BLOCKED, so the constant made a worker killed by its own execution budget — the commonest
 * real failure there is — unretryable: BLOCK, escalate, task failed, no second attempt.
 * `reviewer.test.ts` holds the rule; these hold what this side feeds it.
 */
describe("failureCodeOf", () => {
  it("names the cause for every code the activity throws with", () => {
    expect(failureCodeOf(["WORKER_TIMEOUT: no result within 5000ms"])).toBe("WORKER_TIMEOUT");
    expect(failureCodeOf(["WORKER_AUTHORITY_LOST: lease expired"])).toBe("UNKNOWN_EFFECT");
    expect(
      failureCodeOf(["WORKER_SANDBOX_UNAVAILABLE: no confinement mechanism on this platform"]),
    ).toBe("WORKER_UNAVAILABLE");
  });

  /**
   * THE REAL SHAPE. This is what the workflow actually catches: Temporal's wrapper first,
   * the activity's own message underneath. Classifying the wrapper alone answers
   * `WORKER_FAILED` for every failure there has ever been — measured, after the first
   * version of this fix changed nothing at all.
   */
  it("looks past Temporal's wrapper to the cause that names itself", () => {
    const wrapped = new Error("Activity task failed", {
      cause: new Error("WORKER_TIMEOUT: no result within 5000ms"),
    });

    expect(causeMessages(wrapped)).toEqual([
      "Activity task failed",
      "WORKER_TIMEOUT: no result within 5000ms",
    ]);
    expect(failureCodeOf(causeMessages(wrapped))).toBe("WORKER_TIMEOUT");
  });

  it("carries the cause into the reported message instead of the wrapper alone", () => {
    const wrapped = new Error("Activity task failed", {
      cause: new Error("WORKER_SANDBOX_UNAVAILABLE: no confinement mechanism"),
    });

    expect(causeMessages(wrapped).join(" <- ")).toContain("WORKER_SANDBOX_UNAVAILABLE");
  });

  it("walks a bounded depth and never loops on a cyclic chain", () => {
    const a = new Error("WORKER_FAILED: a");
    const b = new Error("Activity task failed", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    expect(causeMessages(b).length).toBeLessThanOrEqual(5);
  });

  it("admits it does not know rather than inventing a cause", () => {
    for (const message of [
      "",
      "worker returned no structured status: no output",
      "WORKER_EXECUTOR_UNDECLARED: ICOS_WORKER_EXEC_COMMANDS has no 'binary' runtime",
      /* A prefix must be the WHOLE code, not a substring of a message. */
      "the log mentions WORKER_TIMEOUT: but that is not what failed",
      "worker_timeout: lowercase is not the contract",
    ]) {
      expect(failureCodeOf([message])).toBe("WORKER_FAILED");
    }
    expect(failureCodeOf([])).toBe("WORKER_FAILED");
  });

  it("never produces a code the completion route rejects", () => {
    const messages = [
      "WORKER_TIMEOUT: no result within 900000ms",
      "WORKER_AUTHORITY_LOST: revoked",
      "WORKER_SANDBOX_UNAVAILABLE: none",
      "anything else at all",
    ];

    for (const message of messages) {
      const parsed = executionCompletedBodySchema.safeParse(failurePayload("hermes", message));
      expect(parsed.success).toBe(true);
    }
  });
});

/**
 * WHAT A FAILURE IS ALLOWED TO CARRY INTO THE LEDGER.
 *
 * The activity attaches the worker's stderr to its reason, deliberately — a worker that
 * died saying why is not a silent worker. That text is UNTRUSTED and now actually reaches
 * `task_execution_results` and the Cockpit, because the failure report stopped discarding
 * the activity's message in favour of Temporal's wrapper. So the exposure this opens is
 * closed where the text is attached, with the rule ICOS already owns.
 */
describe("an untrusted failure reason cannot carry a credential", () => {
  it("masks what a dying worker echoed, and keeps what diagnoses it", () => {
    const leaked = firstLineRedacted(
      "fatal: auth failed for Bearer sk-abcdef0123456789abcdef0123456789\nsecond line",
    );

    expect(leaked).not.toContain("sk-abcdef0123456789abcdef0123456789");
    expect(leaked).toContain("<redacted>");
    /* One line only: a stack or a response body is not a reason. */
    expect(leaked).not.toContain("second line");
    expect(leaked.length).toBeLessThanOrEqual(200);
  });

  it("still carries the short causes this lane actually debugged", () => {
    expect(firstLineRedacted("index.lock: Operation not permitted")).toBe(
      "index.lock: Operation not permitted",
    );
    expect(firstLineRedacted("WORKER_WORKSPACE_NOT_A_WORKTREE: .git illisible")).toContain(
      "WORKER_WORKSPACE_NOT_A_WORKTREE",
    );
  });
});
