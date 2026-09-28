import { WorkerRegistryEntry, WorkerRegistryPort } from "@/core/contracts/worker-registry";

/**
 * In-memory implementation of the worker registry.
 * Deterministic and fail-closed for unknown values.
 */
export class InMemoryWorkerRegistry implements WorkerRegistryPort {
  private workers: WorkerRegistryEntry[] = [];

  constructor(initialWorkers: WorkerRegistryEntry[] = []) {
    // Defensive copy of initial workers
    this.workers = [...initialWorkers];
  }

  /**
   * Register a worker. Throws if a worker with the same ID already exists.
   */
  register(worker: WorkerRegistryEntry): void {
    if (this.workers.some((w) => w.id === worker.id)) {
      throw new Error(`Worker with ID ${worker.id} already exists`);
    }
    this.workers.push({ ...worker });
  }

  /** Insert or replace, so a live view can follow the durable store (defect 31). */
  upsert(worker: WorkerRegistryEntry): void {
    const index = this.workers.findIndex((w) => w.id === worker.id);
    if (index === -1) this.workers.push({ ...worker });
    else this.workers[index] = { ...worker };
  }

  /**
   * Unregister a worker by ID.
   */
  unregister(id: string): void {
    const index = this.workers.findIndex((w) => w.id === id);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
  }

  /** List all registered workers (defensive copy). */
  listWorkers(): WorkerRegistryEntry[] {
    return [...this.workers];
  }

  /** Get a worker by its ID (defensive copy or undefined). */
  getWorker(id: string): WorkerRegistryEntry | undefined {
    const worker = this.workers.find((w) => w.id === id);
    return worker ? { ...worker } : undefined;
  }

  /** Get workers by their kind (defensive copy). */
  getByKind(workerKind: string): WorkerRegistryEntry[] {
    return this.workers
      .filter((w) => w.workerKind === workerKind)
      .map((w) => ({ ...w }));
  }

  /**
   * Returns a deterministic snapshot of the registry state.
   * The snapshot is a defensive copy, sorted by ID for deterministic order.
   */
  snapshot(): WorkerRegistryEntry[] {
    // Sort by ID to ensure deterministic order
    return [...this.workers]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => ({ ...w }));
  }
}