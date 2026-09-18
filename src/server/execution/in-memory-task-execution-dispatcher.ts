import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "./ports";

/**
 * In-Memory Task Execution Dispatcher
 *
 * Simple fallback dispatcher for tests and backwards compatibility.
 * Returns a mock workflowId without any actual execution.
 */
export class InMemoryTaskExecutionDispatcher implements TaskExecutionDispatcher {
  async dispatch(
    input: TaskExecutionDispatchInput,
    _digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult> {
    const { taskId } = input;
    return { workflowId: input.workflowId ?? `inmem-${taskId}-${Date.now()}` };
  }
}
