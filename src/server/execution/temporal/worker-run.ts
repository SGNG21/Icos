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
  const status =
    usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;

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

/**
 * THE KINDS ICOS'S COMPLETION CALLBACK ACCEPTS.
 *
 * Mirrors `workerKindSchema`, which VALIDATES the field: a value outside this set is
 * rejected `invalid_input`, and a rejected completion callback means the execution is
 * never recorded at all. Held here, beside the rest of the result contract, rather than
 * inside the workflow — the workflow module is bundled into Temporal's isolate, where
 * every export is a workflow definition.
 */
const REPORTABLE_WORKER_KINDS: ReadonlySet<string> = new Set([
  "hermes",
  "openhands",
  "digitalos",
  "agent",
  "other",
]);

/**
 * WHICH KIND TO REPORT — and why it is never the executable that ran.
 *
 * The completion contract has two fields answering different questions:
 *
 *   workerKind       the routed KIND, from the closed set above. VALIDATED.
 *   actualExecutor   free-form, up to 200 characters: what actually ran, as observed.
 *
 * Generalising this contract beyond hermes correctly stopped the workflow asserting
 * `workerKind: "hermes"` — but it put the OBSERVED EXECUTOR in `workerKind` (a filesystem
 * path, on the success path) and the literal `"unknown"` on the failure path. Neither is a
 * member of the closed set, so every completion callback, success and failure alike, came
 * back HTTP 400.
 *
 * That produced the exact defect shape this lane exists to remove: the dispatch succeeded,
 * the worker ran and reported, ICOS refused the report, Temporal retried it twenty times
 * and gave up — and the attempt sat at `dispatched` for ever with no result, no
 * quality-control job, the reviewer never asked, and a missing review as the only symptom.
 *
 * So the reported kind is the kind ICOS ROUTED, and `other` when it routed none or routed
 * something this set does not name — `other` being the set's own word for an executor that
 * is none of the named ones. The generalisation is kept where it belongs: the real
 * executor still travels, unchanged, in `actualExecutor`.
 */
export function reportableWorkerKind(routed: string | undefined): string {
  return routed && REPORTABLE_WORKER_KINDS.has(routed) ? routed : "other";
}

/**
 * THE CODE A FAILURE ACTUALLY HAD, from the stable prefix the activity threw with.
 *
 * The workflow's catch reported `WORKER_FAILED` for EVERY failure, a constant. It reads
 * like a detail and is not one: the canonical review's hard rule (DeterministicReviewer,
 * RULE 1) decides from this very code whether a failed execution may be RE-EXECUTED or
 * must be BLOCKED —
 *
 *   retryable = WORKER_TIMEOUT | WORKER_UNAVAILABLE | UNKNOWN_EFFECT  → RETRY
 *   anything else                                                    → BLOCK
 *
 * — so a worker KILLED BY ITS OWN EXECUTION BUDGET arrived at the reviewer indistinguishable
 * from a worker that ran and reported "this cannot be done". It was BLOCKed, escalated, and
 * its task failed with no second attempt: the single most common real failure (an agent
 * killed mid-task, self-build run 2) was the one QC could never retry.
 *
 * The codes below are not inferred from message text in general — they are the stable
 * prefixes the activity DELIBERATELY throws:
 *
 *  - a timeout is named a timeout. `toExecutionErrorCode` answers `UNKNOWN_EFFECT` for the
 *    EXECUTION_TIMEOUT class, and says why: it is a pure function of the class "with no
 *    evidence in hand, so it must stay conservative". Here the cause is known exactly, and
 *    `WORKER_TIMEOUT` is the business vocabulary's own word for it. Both codes are retryable,
 *    so this names the cause more precisely without deciding anything differently;
 *  - a lost authority (lease expired or revoked mid-run) is `UNKNOWN_EFFECT`, matching that
 *    function's LEASE_EXPIRED: what the worker had already written is unknown — the honest
 *    answer, never a success;
 *  - a platform with no confinement mechanism never spawned anything, so nothing about the
 *    TASK failed: `WORKER_UNAVAILABLE`, exactly as that function answers for a provider that
 *    refused to serve.
 *
 * Unrecognised stays `WORKER_FAILED`: the default is the admission "I do not know", and
 * what is forbidden is only that a KNOWN cause be lost in it.
 */
const FAILURE_CODE_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["WORKER_TIMEOUT", "WORKER_TIMEOUT"],
  ["WORKER_AUTHORITY_LOST", "UNKNOWN_EFFECT"],
  ["WORKER_SANDBOX_UNAVAILABLE", "WORKER_UNAVAILABLE"],
];

/**
 * THE CAUSE CHAIN, DEEPEST CAUSE INCLUDED.
 *
 * What the workflow catches from a failed activity is Temporal's own wrapper, whose message
 * is the constant `Activity task failed`; the activity's own message — the only one that
 * says WHAT failed — hangs off `cause`. So the workflow reported `Activity task failed` as
 * the error message of every single failure, and reading only that message is also why the
 * first attempt at classifying them still answered `WORKER_FAILED` for a timeout.
 *
 * Bounded depth: a cause chain is data from a library, and an unbounded walk over data is a
 * loop waiting for a cycle.
 */
export function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) break;
    if (current.message) messages.push(current.message);
    current = current.cause;
  }
  return messages.length > 0 ? messages : [String(error)];
}

/** The first cause in the chain that names itself; `WORKER_FAILED` when none does. */
export function failureCodeOf(messages: readonly string[]): string {
  for (const message of messages) {
    const found = FAILURE_CODE_BY_PREFIX.find(([prefix]) => message.startsWith(`${prefix}:`));
    if (found) return found[1];
  }
  return "WORKER_FAILED";
}
