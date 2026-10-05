/**
 * THE WORKER RESULT CONTRACT — did this run succeed, according to the run itself?
 *
 * Stdout must NEVER decide success. The original executor (hermes) exits 0 and prints
 * the provider's error text when a call fails, so string matching would read a failure
 * as a result. Fail closed instead: without an explicit `completed === true` and
 * `failed === false` in the structured status the run writes, the run failed.
 *
 * NOT HERMES-SPECIFIC, despite where it came from. Every declared executor reports the
 * same way, because the activity substitutes the workspace path into its argv and then
 * reads one status file from it — so "which program ran" and "how success is reported"
 * stay separate questions. This used to be named for hermes and phrased for hermes,
 * which made the only durable execution path quietly unusable by anything else: the
 * executable allowlist and the read-only repository were the first two walls, and this
 * was the third, because a worker that ran and wrote files still reported WORKER_FAILED.
 *
 * What it deliberately does NOT decide is whether the WORK was any good. "The process
 * said it finished" is not "the expected files changed, and the tests pass" — that is
 * the completion contract, it is a different question, and it belongs to the reviewer
 * and the IntegrationGate downstream rather than here.
 */
export type WorkerRunClassification =
  | { readonly ok: true; readonly result: string; readonly model?: string }
  | {
      readonly ok: false;
      readonly code: "WORKER_FAILED" | "INVALID_RESULT";
      readonly message: string;
    };

const MAX_MESSAGE = 300;

export function classifyWorkerRun(stdout: string, usage: unknown): WorkerRunClassification {
  const text = stdout.trim();
  const status = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;

  if (!status || status.completed !== true || status.failed !== false) {
    const detail = text ? text.slice(0, MAX_MESSAGE) : "no output";
    return {
      ok: false,
      code: "WORKER_FAILED",
      message: status
        ? `worker run failed: ${detail}`
        : `worker returned no structured status: ${detail}`,
    };
  }
  if (!text) {
    return { ok: false, code: "INVALID_RESULT", message: "worker completed with an empty result" };
  }
  return {
    ok: true,
    result: text,
    ...(typeof status.model === "string" ? { model: status.model } : {}),
  };
}
