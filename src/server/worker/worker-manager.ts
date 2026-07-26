import { randomUUID } from "node:crypto";

import type {
  ExecutionResult,
  ExecuteStepInput,
  RuntimeAdapterInput,
} from "@/core/runtime";
import type { Worker, WorkerResult, WorkerStatus, CreateWorkerInput } from "@/core/worker";
import { isWorkerTransitionAllowed, isWorkerTerminal } from "@/core/worker";
import type { RuntimeExecutionPort } from "@/server/runtime/ports";
import type { D1PolicyPort } from "@/server/policy/ports";
import type { WorkerManagerPort, Semaphore } from "./ports";

// ─────────────────────────────────────
// Semaphore implementation
// ─────────────────────────────────────

/**
 * Sémaphore basé sur des promesses pour limiter la concurrence.
 * Garantit que max concurrent workers ne sont pas dépassés.
 */
export class PromiseSemaphore implements Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error("Le sémaphore doit autoriser au moins 1 slot");
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // Permet au suivant d'entrer, current reste stable
    } else {
      this.current = Math.max(0, this.current - 1);
    }
  }

  getAvailablePermits(): number {
    return Math.max(0, this.max - this.current - this.queue.length);
  }
}

// ─────────────────────────────────────
// Worker entry
// ─────────────────────────────────────

interface WorkerEntry {
  worker: Worker;
  abortController?: AbortController;
  promise?: Promise<WorkerResult>;
}

// ─────────────────────────────────────
// WorkerManager
// ─────────────────────────────────────

/**
 * Gestionnaire de workers.
 *
 * Orchestre le cycle de vie complet :
 * 1. Vérification D1
 * 2. Réservation de slot (sémaphore)
 * 3. Exécution via D4 ExecutionPort
 * 4. Collecte du résultat
 * 5. Gestion timeout/cancellation
 */
export class WorkerManager implements WorkerManagerPort {
  private readonly workers = new Map<string, WorkerEntry>();
  private readonly semaphore: Semaphore;

  constructor(
    private readonly runtime: RuntimeExecutionPort,
    private readonly policy: D1PolicyPort,
    maxConcurrentWorkers = 4,
  ) {
    this.semaphore = new PromiseSemaphore(maxConcurrentWorkers);
  }

  get maxConcurrent(): number {
    return (this.semaphore as PromiseSemaphore)["max"] ?? 4;
  }

  /**
   * Retourne le nombre de workers actuellement actifs.
   */
  get activeCount(): number {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (!isWorkerTerminal(entry.worker.status)) {
        count++;
      }
    }
    return count;
  }

  // ─────────────────────────────────────
  // Spawn
  // ─────────────────────────────────────

  async spawn(input: CreateWorkerInput): Promise<string> {
    const workerId = `worker-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Vérification D1 avant création
    const policyDecision = await this.policy.decide({
      actor: { kind: "agent", id: "supervisor", tenantId: input.tenantId },
      tenant: { tenantId: input.tenantId },
      action: input.permissionEnvelope.action,
      resource: {
        type: "worker-execution",
        id: workerId,
        ownerTenantId: input.tenantId,
      },
      capabilityKey: input.permissionEnvelope.capabilityKey,
      risk: "reversible",
    });

    if (policyDecision.outcome === "deny") {
      throw new Error(`Worker refusé par D1 : ${policyDecision.reason}`);
    }

    const worker: Worker = {
      id: workerId,
      spec: {
        taskId: input.taskId,
        missionId: input.missionId,
        tenantId: input.tenantId,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        modelProfile: input.modelProfile ?? "BEST_CODING",
        skillRequirements: input.skillRequirements ?? [],
        toolRequirements: input.toolRequirements ?? [],
        permissionEnvelope: input.permissionEnvelope,
        timeoutMs: input.timeoutMs ?? 300_000,
        budget: input.budget ?? {},
        reviewPolicy: {
          requiresReview: input.requiresReview ?? true,
          reviewerCount: 1,
        },
      },
      status: "CREATED",
      createdAt: now,
      updatedAt: now,
    };

    const entry: WorkerEntry = { worker };
    this.workers.set(workerId, entry);

    // Lancement asynchrone (retourne immédiatement l'ID)
    entry.promise = this.startWorker(workerId).then(
      () => entry.worker.result ?? this.createFallbackResult("Worker terminé sans résultat"),
      (error) => {
        const message = error instanceof Error ? error.message : "Erreur inconnue";
        return this.createFallbackResult(message);
      },
    );

    return workerId;
  }

  private createFallbackResult(message: string): WorkerResult {
    return {
      outcome: "FAILED",
      summary: message,
      errorCode: "INTERNAL_ERROR",
      errorMessage: message,
      durationMs: 0,
    };
  }

  /**
   * Exécution asynchrone du worker.
   */
  private async startWorker(workerId: string): Promise<void> {
    const entry = this.workers.get(workerId);
    if (!entry) return;

    // Acquérir un slot du sémaphore
    await this.semaphore.acquire();

    try {
      await this.executeWorker(workerId);
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Exécute le worker via D4.
   */
  private async executeWorker(workerId: string): Promise<void> {
    const entry = this.workers.get(workerId);
    if (!entry) return;

    const abortController = new AbortController();
    entry.abortController = abortController;

    const worker = entry.worker;
    const timeoutMs = worker.spec.timeoutMs;

    try {
      // CREATED → RUNNING
      this.transitionWorker(workerId, "RUNNING");

      // Construire l'input D4
      const stepInput: ExecuteStepInput = {
        missionId: worker.spec.missionId,
        tenantId: worker.spec.tenantId,
        runId: worker.id,
        stepIndex: 0,
        stepDescription: worker.spec.objective,
        skillKey: worker.spec.skillRequirements[0],
        agentId: "supervisor-worker",
        correlationId: worker.id,
        timeoutMs,
        hasExternalEffect: false,
      };

      // Exécuter via D4
      const executionResult = await this.runtime.execute(stepInput, abortController.signal);

      // Traiter le résultat D4
      const result = this.mapExecutionResult(executionResult, worker);

      // Marquer le worker comme terminé
      entry.worker.result = result;
      entry.worker.workspacePath = undefined;
      this.transitionWorker(workerId, this.mapStatus(result.outcome));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      entry.worker.result = {
        outcome: "FAILED",
        summary: message,
        errorCode: "INTERNAL_ERROR",
        errorMessage: message,
        durationMs: 0,
      };
      this.transitionWorker(workerId, "FAILED");
    }
  }

  // ─────────────────────────────────────
  // Status & result
  // ─────────────────────────────────────

  async getStatus(workerId: string): Promise<{ status: WorkerStatus; worker: Worker | null }> {
    const entry = this.workers.get(workerId);
    if (!entry) return { status: "CANCELLED", worker: null };
    return { status: entry.worker.status, worker: entry.worker };
  }

  async collectResult(workerId: string): Promise<WorkerResult | null> {
    const entry = this.workers.get(workerId);
    if (!entry) return null;
    if (entry.worker.result) return entry.worker.result;

    // Attendre le résultat si le worker est en cours
    if (entry.promise) {
      return entry.promise;
    }

    return null;
  }

  async waitForCompletion(workerId: string, timeoutMs?: number): Promise<WorkerResult> {
    const entry = this.workers.get(workerId);
    if (!entry) {
      return {
        outcome: "FAILED",
        summary: "Worker introuvable",
        errorCode: "WORKER_LOST",
        durationMs: 0,
      };
    }

    if (entry.worker.result) return entry.worker.result;

    // Attendre avec timeout
    if (entry.promise) {
      if (timeoutMs) {
        const timeoutPromise = new Promise<WorkerResult>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout d'attente du worker")), timeoutMs),
        );
        return Promise.race([entry.promise, timeoutPromise]);
      }
      return entry.promise;
    }

    return {
      outcome: "FAILED",
      summary: "Worker sans promesse d'exécution",
      errorCode: "INTERNAL_ERROR",
      durationMs: 0,
    };
  }

  async cancel(workerId: string): Promise<void> {
    const entry = this.workers.get(workerId);
    if (!entry || isWorkerTerminal(entry.worker.status)) return;

    entry.abortController?.abort();
    this.transitionWorker(workerId, "CANCELLED");
  }

  async markLost(workerId: string): Promise<void> {
    const entry = this.workers.get(workerId);
    if (!entry || isWorkerTerminal(entry.worker.status)) return;

    entry.worker.result = {
      outcome: "FAILED",
      summary: "Worker perdu (processus disparu)",
      errorCode: "WORKER_LOST",
      durationMs: entry.worker.result?.durationMs ?? 0,
    };
    this.transitionWorker(workerId, "LOST");
  }

  // ─────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────

  private transitionWorker(workerId: string, target: WorkerStatus): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;

    const current = entry.worker.status;
    if (!isWorkerTransitionAllowed(current, target)) return;

    const now = new Date().toISOString();
    entry.worker = {
      ...entry.worker,
      status: target,
      updatedAt: now,
      startedAt: current === "CREATED" && target === "RUNNING" ? now : entry.worker.startedAt,
      completedAt: isWorkerTerminal(target) ? now : entry.worker.completedAt,
    };
  }

  private mapStatus(outcome: string): WorkerStatus {
    switch (outcome) {
      case "SUCCESS": return "SUCCEEDED";
      case "FAILED": return "FAILED";
      case "BLOCKED": return "FAILED";
      case "NEEDS_REVIEW": return "SUCCEEDED";
      case "NEEDS_HUMAN": return "FAILED";
      default: return "FAILED";
    }
  }

  private mapExecutionResult(execResult: ExecutionResult, worker: Worker): WorkerResult {
    if (execResult.ok) {
      return {
        outcome: "SUCCESS",
        summary: worker.spec.objective,
        artifacts: execResult.artifacts.map((a) => ({
          name: a.name,
          path: a.path,
          mimeType: a.mimeType,
          size: a.size,
        })),
        durationMs: execResult.latencyMs,
      };
    }

    switch (execResult.state) {
      case "TIMED_OUT":
        return {
          outcome: "FAILED",
          summary: `Worker timeout (${worker.spec.timeoutMs}ms)`,
          errorCode: "TIMEOUT",
          errorMessage: execResult.error?.message,
          durationMs: execResult.latencyMs,
        };
      case "CANCELLED":
        return {
          outcome: "FAILED",
          summary: "Worker annulé",
          errorCode: "CANCELLED",
          errorMessage: execResult.error?.message,
          durationMs: execResult.latencyMs,
        };
      default:
        return {
          outcome: "FAILED",
          summary: execResult.error?.message ?? "Échec d'exécution",
          errorCode: execResult.error?.code ?? "INTERNAL_ERROR",
          errorMessage: execResult.error?.message,
          durationMs: execResult.latencyMs,
        };
    }
  }
}
