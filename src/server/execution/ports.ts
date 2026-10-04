import type { ExecutionClass } from "@/core/execution/execution-class";

export interface TaskExecutionDispatchInput {
  missionId?: string;
  taskId: string;
  taskTitle?: string;
  prompt: string;
  /** Optional deterministic id for retries/corrections. */
  workflowId?: string;
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

export interface TaskExecutionDispatchResult {
  workflowId: string;
}

export interface TaskExecutionDispatcher {
  dispatch(
    input: TaskExecutionDispatchInput,
    digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult>;
}
