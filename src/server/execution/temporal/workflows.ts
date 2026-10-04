/**
 * The canonical ICOS task workflow.
 *
 * Invariants:
 *  - a worker success produces exactly one `success` callback carrying the result;
 *  - a worker failure produces exactly one `failure` callback with a normalised error
 *    code — fail closed, never an implied success;
 *  - `workflowId` is the idempotency key ICOS settles on, so a Temporal replay cannot
 *    duplicate the business evidence.
 *
 * The workflow owns no state and makes no decisions: CORE3 owns the task lifecycle,
 * leases and retries. This only carries work to the governed executor and the answer
 * back.
 */
import { proxyActivities, workflowInfo } from "@temporalio/workflow";

import type * as activities from "./activities";

/**
 * The work itself. One attempt: CORE3 already owns retry, review and recovery, so a
 * second retry policy here would re-run work ICOS believes ran once.
 *
 * 16 minutes sits just above the 900 s execution budget the activity enforces, so the
 * BUDGET is the binding constraint and this transport never truncates a run ICOS still
 * considers funded.
 */
const { runGovernedWorker } = proxyActivities<typeof activities>({
  startToCloseTimeout: "16 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * Callbacks into ICOS: bounded but insistent. ICOS being briefly unreachable must not
 * lose a result that was really produced, so Temporal replays these.
 */
const { reportStarted, reportSuccess, reportFailure } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
    maximumAttempts: 20,
  },
});

/** The payload ICOS's dispatcher sends. */
export interface RunTaskInput {
  taskId: string;
  prompt: string;
}

export async function runIcosTask(input: RunTaskInput): Promise<string> {
  const ctx = { taskId: input.taskId, workflowId: workflowInfo().workflowId };
  const startedAt = new Date().toISOString();

  await reportStarted(ctx);

  try {
    const result = await runGovernedWorker(input.prompt);
    await reportSuccess({
      ctx,
      workerKind: "hermes",
      result,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await reportFailure({
      ctx,
      workerKind: "hermes",
      errorCode: "WORKER_FAILED",
      errorMessage: message,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    /* Re-thrown so Temporal records a durable failure too, not just ICOS. */
    throw error;
  }
}
