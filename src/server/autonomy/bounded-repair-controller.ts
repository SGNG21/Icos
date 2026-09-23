import type { WorkerRegistryPort, WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { MissionTask } from "@/core/mission/contracts";
import type { TaskExecutionDispatchInput } from "@/server/execution/ports";

export interface RepairCandidate {
  worker: WorkerRegistryEntry;
  workflowId: string;
  attemptNumber: number;
  repairAttemptId: string;
  parentRepairAttemptId?: string;
}

export interface RepairDecision {
  decision: "RETRY" | "EXHAUSTED" | "HUMAN_DECISION_REQUIRED";
  candidate?: RepairCandidate;
  reason: string;
  attemptsUsed: number;
  maxAttempts: number;
}

export interface BoundedRepairControllerOptions {
  workerRegistry: WorkerRegistryPort;
  workflowId: string;
  maxAttempts?: number;
  requiredCapability?: string;
  requiredWorkerKind?: string;
}

export class BoundedRepairController {
  private readonly workerRegistry: WorkerRegistryPort;
  private readonly workflowId: string;
  private readonly maxAttempts: number;
  private readonly requiredCapability?: string;
  private readonly requiredWorkerKind?: string;

  constructor(options: BoundedRepairControllerOptions) {
    if (!options.workflowId || options.workflowId.trim() === "") {
      throw new Error("Canonical workflowId is required and must not be empty");
    }
    this.workerRegistry = options.workerRegistry;
    this.workflowId = options.workflowId;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.requiredCapability = options.requiredCapability;
    this.requiredWorkerKind = options.requiredWorkerKind;
  }

  private generateRepairAttemptId(attemptNumber: number): string {
    return `repair-${attemptNumber}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private getEligibleWorkers(): WorkerRegistryEntry[] {
    const allWorkers = this.workerRegistry.listWorkers();

    return allWorkers.filter((worker) => {
      if (worker.status !== "active") {
        return false;
      }

      if (worker.runtimeSupport !== "SUPPORTED_RUNTIME") {
        return false;
      }

      // Fail closed: ONLY "healthy" is acceptable, UNKNOWN is ineligible
      if (worker.health !== "healthy") {
        return false;
      }

      // Fail closed: ONLY "available" is acceptable, UNKNOWN is ineligible
      if (worker.availability !== "available") {
        return false;
      }

      if (this.requiredCapability && !worker.capabilities.includes(this.requiredCapability)) {
        return false;
      }

      if (this.requiredWorkerKind && worker.workerKind !== this.requiredWorkerKind) {
        return false;
      }

      return true;
    });
  }

  private selectNextWorker(
    eligibleWorkers: WorkerRegistryEntry[],
    usedWorkerIds: Set<string>,
    parentCandidateId?: string
  ): WorkerRegistryEntry | null {
    // First try: find a worker not yet used
    for (const worker of eligibleWorkers) {
      if (!usedWorkerIds.has(worker.id)) {
        return worker;
      }
    }

    // No alternate worker available - do NOT reuse parent worker for retry
    // This ensures fail-closed behavior when no valid alternate exists
    return null;
  }

  getFirstCandidate(
      missionId: string,
      taskId: string,
      missionTask: MissionTask
    ): RepairDecision {
      const eligibleWorkers = this.getEligibleWorkers();

      if (eligibleWorkers.length === 0) {
        return {
          decision: "HUMAN_DECISION_REQUIRED",
          reason: `No eligible workers found for capability: ${this.requiredCapability ?? "any"}, workerKind: ${this.requiredWorkerKind ?? "any"}`,
          attemptsUsed: 0,
          maxAttempts: this.maxAttempts,
        };
      }

      const selectedWorker = this.selectNextWorker(eligibleWorkers, new Set());

      if (!selectedWorker) {
        return {
          decision: "HUMAN_DECISION_REQUIRED",
          reason: "No available worker after filtering",
          attemptsUsed: 0,
          maxAttempts: this.maxAttempts,
        };
      }

      const repairAttemptId = this.generateRepairAttemptId(1);

      return {
        decision: "RETRY",
        candidate: {
          worker: selectedWorker,
          workflowId: this.workflowId,
          attemptNumber: 1,
          repairAttemptId,
        },
        reason: `First repair attempt with worker ${selectedWorker.id} (${selectedWorker.workerKind})`,
        attemptsUsed: 1,
        maxAttempts: this.maxAttempts,
      };
    }

  getNextCandidate(
      missionId: string,
      taskId: string,
      previousCandidate: RepairCandidate,
      failureReason: string
    ): RepairDecision {
      if (previousCandidate.attemptNumber >= this.maxAttempts) {
        return {
          decision: "EXHAUSTED",
          reason: `Max repair attempts (${this.maxAttempts}) reached. Last failure: ${failureReason}`,
          attemptsUsed: previousCandidate.attemptNumber,
          maxAttempts: this.maxAttempts,
        };
      }

      const eligibleWorkers = this.getEligibleWorkers();

      if (eligibleWorkers.length === 0) {
        return {
          decision: "HUMAN_DECISION_REQUIRED",
          reason: `No eligible workers remaining for capability: ${this.requiredCapability ?? "any"}`,
          attemptsUsed: previousCandidate.attemptNumber,
          maxAttempts: this.maxAttempts,
        };
      }

      const usedWorkerIds = new Set([previousCandidate.worker.id]);
      const nextAttemptNumber = previousCandidate.attemptNumber + 1;

      const selectedWorker = this.selectNextWorker(
        eligibleWorkers,
        usedWorkerIds,
        previousCandidate.worker.id
      );

      if (!selectedWorker) {
        return {
          decision: "HUMAN_DECISION_REQUIRED",
          reason: `All eligible workers exhausted after ${previousCandidate.attemptNumber} attempt(s). No valid alternate worker.`,
          attemptsUsed: previousCandidate.attemptNumber,
          maxAttempts: this.maxAttempts,
        };
      }

      const repairAttemptId = this.generateRepairAttemptId(nextAttemptNumber);

      return {
        decision: "RETRY",
        candidate: {
          worker: selectedWorker,
          workflowId: this.workflowId,
          attemptNumber: nextAttemptNumber,
          repairAttemptId,
          parentRepairAttemptId: previousCandidate.repairAttemptId,
        },
        reason: `Repair attempt ${nextAttemptNumber} with worker ${selectedWorker.id} (${selectedWorker.workerKind}). Previous: ${previousCandidate.worker.id}`,
        attemptsUsed: nextAttemptNumber,
        maxAttempts: this.maxAttempts,
      };
    }

  buildDispatchInput(
    candidate: RepairCandidate,
    baseInput: Omit<TaskExecutionDispatchInput, "workflowId">,
    humanApprovedBy?: string
  ): TaskExecutionDispatchInput {
    return {
      ...baseInput,
      workflowId: candidate.workflowId,
      workerKind: candidate.worker.workerKind,
      capability: this.requiredCapability,
    };
  }
}