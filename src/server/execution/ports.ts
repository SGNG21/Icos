export interface TaskExecutionDispatchInput {
  missionId?: string;
  taskId: string;
  taskTitle?: string;
  prompt: string;
  /** Optional deterministic id for retries/corrections. */
  workflowId?: string;
  workerKind?: string;
  capability?: string;
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
