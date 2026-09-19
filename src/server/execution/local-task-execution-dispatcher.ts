import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "./ports";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import type { ExecutionOutcome, ExecutionError } from "@/core/contracts";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository, TaskRepository } from "@/server/repositories/ports";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

/**
 * Local Task Execution Dispatcher
 *
 * Executes tasks locally by interpreting the prompt as a simple command.
 * Supported commands:
 *   - WRITE_FILE:<filepath>:<content>  -> writes content to filepath
 *   - ECHO:<text>                      -> returns text as output
 *   - anything else                    -> treats as echo and returns the prompt
 *
 * This is used for the MVP to have a real execution path without external dependencies.
 */
export class LocalTaskExecutionDispatcher implements TaskExecutionDispatcher {
  private readonly executedWorkflowIds = new Set<string>();

  constructor(
    private readonly executionResults: TaskExecutionResultRepository,
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly supervisor: SupervisorService,
    private readonly durableMemory: DurableMemory,
  ) {}

  async dispatch(input: TaskExecutionDispatchInput): Promise<TaskExecutionDispatchResult> {
    // Ensure workflowId is present on the input for test compatibility
    if (input.workflowId === undefined) {
      input.workflowId = `icos-local-${input.taskId}-${Date.now()}`;
    }

    const { taskId, prompt, workerKind, capability } = input;
    const workflowId = input.workflowId;

    // If an explicit workflowId is provided, check if we have already executed it.
    if (this.executedWorkflowIds.has(workflowId)) {
      // Already executed: return the workflowId without re-executing.
      return { workflowId };
    }


    let outcome: ExecutionOutcome = "success";
    let output: string | undefined;
    let error: ExecutionError | undefined;

    try {
      if (prompt.startsWith("WRITE_FILE:")) {
        const rest = prompt.substring("WRITE_FILE:".length);
        const [filepath, ...contentParts] = rest.split(":");
        const content = contentParts.join(":"); // allow colons in content
        if (!filepath) {
          throw new Error("WRITE_FILE command requires a filepath");
        }
        const fullPath = join("/tmp/icos", filepath);
        await mkdir(join("/tmp/icos", filepath, ".."), { recursive: true });
        await writeFile(fullPath, content, "utf8");
        output = `Wrote ${content.length} bytes to ${fullPath}`;
      } else if (prompt.startsWith("ECHO:")) {
        output = prompt.substring("ECHO:".length);
      } else {
        // Default: treat as echo
        output = `Echo: ${prompt}`;
      }
    } catch (err) {
      outcome = "failure";
      error = { code: "WORKER_FAILED", message: err instanceof Error ? err.message : String(err) };
      output = undefined;
    }

    const completedAt = new Date().toISOString();


    // Record the execution result (this also transitions the task status atomically via recordTaskExecution)
    await recordTaskExecution(
      {
        tasks: this.tasks,
        executionResults: this.executionResults,
        supervisor: this.supervisor,
        missions: this.missions,
        durableMemory: this.durableMemory,
      },
      {
        taskId,
        workflowId,
        outcome,
        workerKind: "other", // we use "other" as the worker kind for local execution
        capability,
        result: output,
        error,
        completedAt,
      },
    );

    // Mark the workflowId as executed (whether it was provided or generated).
    this.executedWorkflowIds.add(workflowId);


    return { workflowId };
  }
}