import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { WorkerRuntimeDescriptor } from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "./ports";

/**
 * Chooses the executor for a dispatch BY RUNTIME (M8, defect 22).
 *
 * WHY RUNTIME, AND ONLY RUNTIME
 * The runtime is what determines HOW something is executed: a `binary` worker is
 * launched as a process, a Temporal-backed worker is signalled through a workflow. A
 * worker KIND says what the worker is FOR, and a PROVIDER says whose service answers —
 * neither tells you how to start it. Decisions 0031/0036/0038 already settled this for
 * eligibility, probing and execution; this is the same rule at the dispatch seam.
 *
 * `CompositeTaskExecutionDispatcher` branches on the literal kinds "hermes", "openhands"
 * and "digitalos". This router deliberately does NOT extend that pattern, and adding a
 * provider here would re-open the defect the rest of CORE3 spent four milestones closing.
 * Worker != Runtime != Model != Provider != Account != CapacitySlot.
 *
 * FAIL-SAFE BY CONSTRUCTION
 * A dispatch is routed externally only when ALL of these hold: the attempt exists in the
 * ledger, it names a worker, that worker is still registered, and its runtime has a
 * configured external executor adapter. Anything else falls back to the pre-existing
 * dispatcher. With no `ICOS_WORKER_EXEC_COMMANDS` configured the external set is EMPTY
 * and every dispatch behaves exactly as it did before this class existed — so wiring it
 * in cannot regress a deployment that has not opted in.
 */
export interface RuntimeDispatchRouterDeps {
  /** Resolves the attempt, and through it the assigned worker. */
  dispatchAttempts: Pick<DispatchAttemptRepository, "getByWorkflowId">;
  workers: Pick<WorkerRegistryStore, "get">;
  /** Handles runtimes this process can launch itself. */
  external: TaskExecutionDispatcher;
  /** Everything else. The pre-existing production dispatcher. */
  fallback: TaskExecutionDispatcher;
  /** Runtimes the external executor actually has an adapter for. */
  externalRuntimes: readonly WorkerRuntimeDescriptor[];
}

export class RuntimeDispatchRouter implements TaskExecutionDispatcher {
  private readonly externalRuntimes: ReadonlySet<WorkerRuntimeDescriptor>;

  constructor(private readonly deps: RuntimeDispatchRouterDeps) {
    this.externalRuntimes = new Set(deps.externalRuntimes);
  }

  /** Diagnostics: which runtimes this process will execute itself. */
  external(): WorkerRuntimeDescriptor[] {
    return [...this.externalRuntimes].sort();
  }

  async dispatch(
    input: TaskExecutionDispatchInput,
    digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult> {
    const runtime = await this.runtimeOf(input);

    if (runtime && this.externalRuntimes.has(runtime)) {
      return this.deps.external.dispatch(input, digitalosFacadePath);
    }

    return this.deps.fallback.dispatch(input, digitalosFacadePath);
  }

  /**
   * The runtime this dispatch should be executed on, or null when it cannot be known.
   *
   * Null is not a failure here — it means "this dispatch has no durable worker identity",
   * which is the normal shape for every pre-M5 path. It routes to the fallback, exactly
   * as it did before.
   */
  private async runtimeOf(
    input: TaskExecutionDispatchInput,
  ): Promise<WorkerRuntimeDescriptor | null> {
    if (!input.workflowId) return null;

    const attempt = await this.deps.dispatchAttempts.getByWorkflowId(input.workflowId);
    if (!attempt?.workerId) return null;

    /*
     * Read the worker, do not infer from the attempt. `dispatch_attempts` records
     * `worker_kind` but never a runtime, and inferring one from a kind would be the
     * provider-name defect wearing a different hat.
     */
    const worker = await this.deps.workers.get(attempt.workerId);
    return worker?.runtime ?? null;
  }
}
