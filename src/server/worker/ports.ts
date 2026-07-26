import type { Worker, WorkerSpec, WorkerResult, CreateWorkerInput } from "@/core/worker";

// ─────────────────────────────────────
// WorkerManagerPort
// ─────────────────────────────────────

export interface WorkerManagerPort {
  /**
   * Crée et lance un worker.
   * Retourne l'ID du worker immédiatement (asynchrone).
   */
  spawn(input: CreateWorkerInput): Promise<string>;

  /**
   * Récupère l'état actuel d'un worker.
   */
  getStatus(workerId: string): Promise<{ status: Worker["status"]; worker: Worker | null }>;

  /**
   * Récupère le résultat d'un worker (attend la complétion si running).
   */
  collectResult(workerId: string): Promise<WorkerResult | null>;

  /**
   * Annule un worker en cours d'exécution.
   */
  cancel(workerId: string): Promise<void>;

  /**
   * Attend qu'un worker se termine.
   */
  waitForCompletion(workerId: string, timeoutMs?: number): Promise<WorkerResult>;

  /**
   * Bascule un worker en état LOST (quand le processus a disparu).
   */
  markLost(workerId: string): Promise<void>;
}

// ─────────────────────────────────────
// Semaphore (concurrency limiter)
// ─────────────────────────────────────

/**
 * Sémaphore simple pour limiter la concurrence.
 */
export interface Semaphore {
  acquire(): Promise<void>;
  release(): void;
  getAvailablePermits(): number;
}
