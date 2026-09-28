import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerRuntimeDescriptor } from "@/core/contracts/worker-registry";
import {
  isRetryableFailure,
  type WorkerExecutionOutcome,
  type WorkerIdentity,
  type WorkerTaskContract,
} from "@/core/contracts/worker-execution";
import type { WorkerWorkspace } from "./writer-workspace";

/**
 * THE canonical external-worker execution boundary (M6.3, requirement 9).
 *
 * There is exactly ONE of these. `TaskExecutionDispatcher` remains the single
 * entry point the supervisor calls; this sits UNDER it and owns the one question
 * the dispatcher must not answer twice: how a real external process is run,
 * observed and classified.
 *
 * ADAPTERS ARE KEYED BY RUNTIME, NOT BY WORKER KIND
 * The same correction decision 0036 made for probing, for the same reason: the
 * runtime determines HOW to launch, the kind says what the worker is FOR. Twenty
 * kinds on one runtime need one adapter, and a brand-new kind needs none. This is
 * also what keeps provider names out of the core — an adapter is registered as
 * DATA, and no file on this path branches on a provider.
 *
 * WHAT THIS DOES NOT DO
 * It does not choose a worker (that is the CapabilityRouter), does not create or
 * settle the durable attempt (that is the dispatch ledger), and does not decide
 * whether to retry (it only reports whether a failure is retryable). Keeping it
 * this narrow is what stops a second execution path from growing here.
 */

export interface WorkerExecutionRequest {
  /** Identity source. The registry entry is authoritative about the worker. */
  worker: WorkerRegistryEntry;
  contract: WorkerTaskContract;
  workspace: WorkerWorkspace;
  /**
   * FENCING. Asked AFTER the process ends, to answer "did we still own this
   * attempt while we were running it?" A run whose lease expired mid-flight must
   * not be allowed to report a result: another runner may already have redone the
   * work, and two results for one logical attempt is the duplicate-integration
   * failure this whole layer exists to prevent.
   */
  stillOwnsLease?: () => Promise<boolean>;
}

/** One runtime's way of launching a worker. */
export interface WorkerExecutorPort {
  execute(request: WorkerExecutionRequest): Promise<WorkerExecutionOutcome>;
}

export type WorkerExecutorAdapters = Partial<
  Record<WorkerRuntimeDescriptor, WorkerExecutorPort>
>;

/**
 * Derives the six identity axes from the registry entry.
 *
 * Model / provider / account / capacity slot come from the worker's opaque
 * `metadata`, and are never interpreted here — they are recorded so a failure can
 * be attributed to the right axis, which is the entire point of keeping them
 * distinct (see `workerIdentitySchema`).
 */
export function identityOf(worker: WorkerRegistryEntry): WorkerIdentity {
  const metadata = (worker.metadata ?? {}) as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  return {
    workerId: worker.id,
    runtime: worker.runtime,
    model: text("model"),
    provider: text("provider"),
    account: text("account"),
    /* The registry's own capacity concept, not a re-derived one. */
    capacitySlot: worker.capacityPool ?? undefined,
  };
}

export class WorkerExecutor {
  constructor(private readonly adapters: WorkerExecutorAdapters) {}

  /** The runtimes this process can actually execute. Useful for diagnostics. */
  supportedRuntimes(): WorkerRuntimeDescriptor[] {
    return (Object.keys(this.adapters) as WorkerRuntimeDescriptor[]).sort();
  }

  async execute(request: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const identity = identityOf(request.worker);
    const adapter = this.adapters[request.worker.runtime];

    if (!adapter) {
      /*
       * A missing adapter is a CONFIGURATION DEFECT, and it is reported as
       * retryable on purpose. Terminal would fail the task for an operator's
       * mistake, permanently; PROVIDER_UNAVAILABLE says truthfully that nothing
       * ran and the task is untouched, so it survives until the deployment is
       * fixed. The message names the runtime so the fix is obvious.
       */
      return {
        ok: false,
        identity,
        failureClass: "PROVIDER_UNAVAILABLE",
        retryable: isRetryableFailure("PROVIDER_UNAVAILABLE"),
        message: `WORKER_EXECUTOR_UNSUPPORTED_RUNTIME: no executor adapter configured for runtime '${request.worker.runtime}' (worker ${request.worker.id})`,
      };
    }

    /*
     * A writer must never have been handed the canonical checkout. `provisionWorkspace`
     * already refuses to build one, so reaching here means a caller constructed a
     * workspace by hand. Fail closed rather than launch it.
     */
    if (request.workspace.mode === "writer" && !request.workspace.branch) {
      return {
        ok: false,
        identity,
        failureClass: "FAILED_TERMINAL",
        retryable: isRetryableFailure("FAILED_TERMINAL"),
        message:
          "WORKER_WORKSPACE_INVALID: a writer workspace must carry its own branch; refusing to execute",
      };
    }

    let outcome: WorkerExecutionOutcome;
    try {
      outcome = await adapter.execute(request);
    } catch (error) {
      /*
       * An adapter that throws is a broken adapter, not a failed task. Converting
       * it into a classified failure keeps ONE shape for every caller — the same
       * discipline the process runner applies to spawn errors.
       */
      return {
        ok: false,
        identity,
        failureClass: "WORKER_CRASHED",
        retryable: isRetryableFailure("WORKER_CRASHED"),
        message: `WORKER_EXECUTOR_ADAPTER_THREW: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    /*
     * FENCE LAST. Whatever the adapter concluded, if the lease was lost while it
     * ran then this runner is not authorised to report it — including a SUCCESS.
     * Reporting a stale success is how the same logical task gets integrated twice.
     */
    if (request.stillOwnsLease && !(await request.stillOwnsLease())) {
      return {
        ok: false,
        identity,
        failureClass: "LEASE_EXPIRED",
        retryable: isRetryableFailure("LEASE_EXPIRED"),
        message: `WORKER_EXECUTION_FENCED: attempt ${request.contract.missionTaskId}#${request.contract.attempt} lost its execution lease while running`,
        /* Keep what we learned: the next owner resumes rather than restarts. */
        process: outcome.ok ? outcome.process : outcome.process,
        structured: outcome.structured,
        evidence: outcome.evidence,
        resumeToken: outcome.ok ? outcome.resumeToken : outcome.resumeToken,
      };
    }

    return outcome;
  }
}
