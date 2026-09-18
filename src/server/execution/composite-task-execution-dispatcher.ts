import type { TaskExecutionDispatcher } from "./ports";
import type { TaskExecutionDispatchInput } from "./ports";
import type { TaskExecutionDispatchResult } from "./ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";
import type { DurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { TemporalTaskExecutionDispatcher } from "./temporal-task-execution-dispatcher";
import { InMemoryTaskExecutionDispatcher } from "./in-memory-task-execution-dispatcher";
import { DigitalOSTaskExecutionDispatcher } from "./digitalos-task-execution-dispatcher";
import { LocalTaskExecutionDispatcher } from "./local-task-execution-dispatcher";

/**
 * Composite Task Execution Dispatcher
 *
 * Routes to the correct underlying dispatcher based on workerKind and capability.
 * - "hermes", "openhands", "other" -> Temporal dispatcher (PRODUCTION: fail-closed if unavailable)
 * - "digitalos" -> DigitalOS dispatcher (new)
 * - no workerKind -> Local dispatcher (for MVP local execution)
 */
export class CompositeTaskExecutionDispatcher implements TaskExecutionDispatcher {
  constructor(
    private readonly executionResults: TaskExecutionResultRepository,
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly supervisor: SupervisorService,
    private readonly durableMemory: DurableMemory,
    private readonly temporalDispatcher: TaskExecutionDispatcher = new TemporalTaskExecutionDispatcher(),
    private readonly localDispatcher: TaskExecutionDispatcher = new LocalTaskExecutionDispatcher(
      executionResults,
      missions,
      tasks,
      supervisor,
      durableMemory,
    ),
  ) {
    this.digitalosDispatcher = new DigitalOSTaskExecutionDispatcher(
      executionResults,
      missions,
      tasks,
      supervisor,
      durableMemory,
    );
  }

  private readonly digitalosDispatcher: DigitalOSTaskExecutionDispatcher;

  async dispatch(
    input: TaskExecutionDispatchInput,
    digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult> {
    const { workerKind, capability } = input;

    // Route based on workerKind
    if (workerKind === "digitalos" || capability?.startsWith("website.")) {
      return this.digitalosDispatcher.dispatch(input, digitalosFacadePath);
    }

    // Temporal dispatchers for hermes, openhands, other
    // PRODUCTION: No implicit fallback - fail closed if Temporal unavailable
    if (workerKind === "hermes" || workerKind === "openhands" || workerKind === "other") {
      return this.temporalDispatcher.dispatch(input);
    }

    // Fallback to local dispatcher for unknown worker kinds (TEST ONLY)
    return this.localDispatcher.dispatch(input);
  }
}
