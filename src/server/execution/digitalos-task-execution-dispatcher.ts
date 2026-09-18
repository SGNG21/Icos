import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "./ports";
import {
  DigitalOSWorker,
  type DigitalOSWorkerInput,
  type DigitalOSWorkerResult,
} from "./digitalos-worker";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";
import type { DurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import type {
  ExecutionOutcome,
  ExecutionError,
  WorkerKind,
  Artifact,
  Evidence,
  Finding,
} from "@/core/contracts";

/**
 * DigitalOS Task Execution Dispatcher
 *
 * Implements TaskExecutionDispatcher interface for DigitalOS capabilities.
 * - Receives taskId, prompt, workerKind, capability from Supervisor
 * - Creates DigitalOS ExecutionInput
 * - Executes via DigitalOSWorker
 * - Records result via recordTaskExecution usecase (idempotent, atomic with task transition)
 */
export class DigitalOSTaskExecutionDispatcher implements TaskExecutionDispatcher {
  constructor(
    private readonly executionResults: TaskExecutionResultRepository,
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly supervisor: SupervisorService,
    private readonly durableMemory: DurableMemory,
  ) {}

  private worker = new DigitalOSWorker();

  async dispatch(
    input: TaskExecutionDispatchInput,
    digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult> {
    const { taskId, prompt, workerKind, capability } = input;

    // Only handle digitalos worker kind
    if (workerKind !== "digitalos" && workerKind !== undefined) {
      // Not for us - but per interface we must return a workflowId
      // The composite dispatcher should route correctly, but fail-safe
      return { workflowId: `icos-task-${taskId}` };
    }

    if (!capability) {
      throw new Error(`DigitalOS dispatch requires capability, got: ${capability}`);
    }

    // Get mission info for the task
    const missionTask = await this.findMissionTaskForCanonicalTask(taskId);
    const missionId = missionTask?.missionId;

    // Build worker input
    const workerInput: DigitalOSWorkerInput = {
      taskId,
      workflowId: input.workflowId ?? `icos-task-${taskId}`,
      capability,
      prompt: prompt || `Execute ${capability}`,
      projectId: missionId ? `icos-mission-${missionId}` : `icos-task-${taskId}`,
      missionId,
      digitalosFacadePath,
      options: {
        baseDir: "/Users/coco/digitalos-usine-benchmark-du-sol-au-toit", // DigitalOS project root (contains usine/)
      },
    };

    // Execute via DigitalOS worker
    const workerResult: DigitalOSWorkerResult = await this.worker.execute(workerInput);

    // Record the execution result (this also transitions the task status atomically)
    const recordInput: {
      taskId: string;
      workflowId: string;
      outcome: ExecutionOutcome;
      workerKind: WorkerKind;
      capability?: string;
      digitalosExecutionId?: string;
      result?: string;
      error?: ExecutionError;
      startedAt?: string;
      completedAt: string;
      artifacts?: Artifact[];
      evidence?: Evidence[];
      findings?: Finding[];
    } = {
      taskId,
      workflowId: workerInput.workflowId,
      outcome:
        workerResult.outcome === "success"
          ? "success"
          : workerResult.outcome === "blocked"
            ? "failure"
            : "failure",
      workerKind: "digitalos",
      capability: workerInput.capability,
      digitalosExecutionId: workerResult.digitalosExecutionId,
      result: workerResult.result,
      error: workerResult.error,
      startedAt: workerResult.startedAt,
      completedAt: workerResult.completedAt,
      artifacts: workerResult.artifacts,
      evidence: workerResult.evidence,
      findings: workerResult.findings,
    };

    // Note: The recordTaskExecution usecase handles the atomic record + task transition
    // This ensures idempotency (workflowId key) and task status consistency
    await recordTaskExecution(
      {
        tasks: this.tasks,
        executionResults: this.executionResults,
        supervisor: this.supervisor,
        missions: this.missions,
        durableMemory: this.durableMemory,
      },
      recordInput,
    );

    return { workflowId: workerInput.workflowId };
  }

  /**
   * Find the MissionTask that references this canonical taskId
   * Needed to get missionId for context
   */
  private async findMissionTaskForCanonicalTask(
    canonicalTaskId: string,
  ): Promise<{ missionId: string } | null> {
    const missions = await this.missions.list();
    for (const mission of missions) {
      const tasks = await this.missions.listTasks(mission.id);
      const found = tasks.find((t) => t.taskId === canonicalTaskId);
      if (found) {
        return { missionId: mission.id };
      }
    }
    return null;
  }
}
