export function workflowIdForAttempt(
  taskId: string,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Invalid execution attempt: ${attempt}`);
  }

  // Preserve the N1 contract for first executions.
  if (attempt === 1) {
    return `icos-task-${taskId}`;
  }

  return `icos-task-${taskId}-attempt-${attempt}`;
}
