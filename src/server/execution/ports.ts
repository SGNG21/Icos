import type { ExecutionClass } from "@/core/execution/execution-class";

export interface TaskExecutionDispatchInput {
  missionId?: string;
  taskId: string;
  taskTitle?: string;
  prompt: string;
  /** Optional deterministic id for retries/corrections. */
  workflowId?: string;
  /**
   * WHICH ATTEMPT of this task, issued by CORE3 and by nothing else.
   *
   * The dispatcher needs it to tell "the execution I am asking for" apart from "some
   * execution that happens to carry this workflow id". Temporal workflow ids are global
   * and persistent, so an id can already refer to a different attempt, a different queue
   * or a closed run; without the attempt there is no way to prove a returned handle is
   * the canonical ICOS execution, and a reuse decision made without that proof is how a
   * false dispatch success is reported.
   *
   * The adapter never derives or increments it: a retry gets its new attempt identity
   * from CORE3 (see `workflowIdForAttempt`), which is what keeps one logical attempt from
   * executing twice.
   */
  attempt?: number;
  workerKind?: string;
  capability?: string;
  /**
   * WHICH ORCHESTRATOR, declared by the caller. Required: see `execution-class.ts` — the
   * router used to infer this from executor configuration, so declaring an executor
   * silently moved mission work onto a non-durable path.
   */
  executionClass?: ExecutionClass;
  digitalosFacadePath?: string;
  signal?: AbortSignal;
}

/**
 * WHAT ACTUALLY HAPPENED, not merely "no exception was thrown".
 *
 * `started`     a new durable execution was created by this call;
 * `reused`      the canonical execution for this exact task+attempt was already open,
 *               so this call is an idempotent no-op on it;
 * `reconciled`  that execution has already finished and ICOS holds its durable terminal
 *               result, so the work must NOT run again and there is nothing to dispatch.
 *
 * Three answers rather than one boolean because they oblige the caller differently, and
 * because a dispatcher that cannot say which of them occurred cannot be held to never
 * reporting a false success.
 */
export type TaskExecutionDispatchDisposition = "started" | "reused" | "reconciled";

export interface TaskExecutionDispatchResult {
  workflowId: string;
  /**
   * Absent on adapters that cannot distinguish the cases. Absent is NOT "started":
   * a caller that needs the distinction must require the field.
   */
  disposition?: TaskExecutionDispatchDisposition;
}

/**
 * Whether ICOS already holds the canonical terminal result for one durable execution.
 *
 * A narrow port on purpose. The durable adapter must be able to tell a finished execution
 * apart from an abandoned one, and that answer lives in ICOS's own settlement evidence —
 * but giving the adapter the whole result repository would let a transport reach into
 * business state it has no business writing. One read-only question is all it needs.
 */
export interface DurableExecutionReconciler {
  hasTerminalResult(workflowId: string): Promise<boolean>;
}

export interface TaskExecutionDispatcher {
  dispatch(
    input: TaskExecutionDispatchInput,
    digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult>;
}
