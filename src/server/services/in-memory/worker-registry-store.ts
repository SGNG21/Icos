import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";

/** In-memory parity implementation of the durable worker registry store. */
export class InMemoryWorkerRegistryStore implements WorkerRegistryStore {
  private readonly rows = new Map<string, WorkerRegistryEntry>();

  constructor(initial: readonly WorkerRegistryEntry[] = []) {
    for (const worker of initial) {
      this.rows.set(worker.id, { ...worker });
    }
  }

  async list(): Promise<WorkerRegistryEntry[]> {
    return [...this.rows.values()]
      .map((worker) => ({ ...worker }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<WorkerRegistryEntry | null> {
    const worker = this.rows.get(id);
    return worker ? { ...worker } : null;
  }

  async upsert(worker: WorkerRegistryEntry): Promise<WorkerRegistryEntry> {
    this.rows.set(worker.id, { ...worker });
    return { ...worker };
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}
