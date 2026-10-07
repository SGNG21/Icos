import { describe, expect, it } from "vitest";

import { workerKindSchema } from "@/core/contracts/task-execution";
import { executionCompletedBodySchema } from "@/server/http/execution-schemas";

import { reportableWorkerKind } from "./worker-run";

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
    error: { code: "WORKER_FAILED", message },
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
