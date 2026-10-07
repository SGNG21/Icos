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

import { reportableWorkerKind } from "./worker-run";

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

/**
 * The payload ICOS's dispatcher sends.
 *
 * `workerKind` is the KIND ICOS routed this task to — one of a closed set the callback
 * contract validates (`workerKindSchema`). It was missing from this interface while the
 * dispatcher had always been sending it, and a payload field the workflow cannot see is a
 * field the workflow will eventually invent a substitute for, which is exactly what went
 * wrong below.
 */
export interface RunTaskInput {
  taskId: string;
  prompt: string;
  workerKind?: string;
}

export async function runIcosTask(input: RunTaskInput): Promise<string> {
  const ctx = { taskId: input.taskId, workflowId: workflowInfo().workflowId };
  const startedAt = new Date().toISOString();

  await reportStarted(ctx);

  try {
    /*
     * The context travels with the work: the activity asks ICOS what this execution is
     * allowed to do, and identifiers are all it may send to get that answer.
     */
    const run = await runGovernedWorker(ctx, input.prompt);
    await reportSuccess({
      ctx,
      /*
       * The routed KIND, which the callback contract validates — never the executable,
       * which goes in `actualExecutor` below and is still reported by the run rather than
       * asserted here.
       */
      workerKind: reportableWorkerKind(input.workerKind),
      result: run.result,
      actualExecutor: run.actualExecutor,
      ...(run.actualProvider ? { actualProvider: run.actualProvider } : {}),
      ...(run.actualModel ? { actualModel: run.actualModel } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
    });
    return run.result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await reportFailure({
      ctx,
      /*
       * A failure before the run resolved its executor cannot name one — so it reports
       * the kind ICOS routed, falling back to the closed set's own name for "none of the
       * named ones". It must not be `"unknown"`: that is not a member of the set, so the
       * callback was refused and the failure was never recorded at all.
       */
      workerKind: reportableWorkerKind(input.workerKind),
      errorCode: "WORKER_FAILED",
      errorMessage: message,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    /* Re-thrown so Temporal records a durable failure too, not just ICOS. */
    throw error;
  }
}
