import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";

/** The synchronous side that has to be kept in step with the durable store. */
export interface WorkerRegistryMirror {
  upsert(worker: WorkerRegistryEntry): void;
  unregister(id: string): void;
}

/**
 * KEEPS THE SYNCHRONOUS FLEET VIEW HONEST (defect 31).
 *
 * `WorkerRegistryPort` is synchronous, so the container satisfied it by taking ONE snapshot
 * of the durable store at boot: `new InMemoryWorkerRegistry(await store.list())`. Everything
 * that registers, probes, deactivates or expires a worker writes to the STORE, so the
 * snapshot was correct for exactly as long as the fleet did not change — and in a real
 * deployment workers register themselves AFTER boot.
 *
 * The consequence was not a stale read, it was a fail-closed dead end: the reviewer
 * independence rule reads this port, found a fleet frozen at boot, and answered
 * NO_INDEPENDENT_REVIEWER for every worker that had registered since. Self-development could
 * therefore never be reviewed in any deployment whose workers come up after the runtime.
 *
 * Mirroring lives at the STORE, not in the registration service, because registration is not
 * the only writer: health probes and stale-evidence expiry write here too, and a mirror that
 * only followed registration would drift on exactly the evidence routing depends on.
 *
 * The mirror is updated only AFTER the durable write succeeds. The durable store remains the
 * source of truth; this view never becomes a second one.
 */
export class MirroringWorkerRegistryStore implements WorkerRegistryStore {
  constructor(
    private readonly inner: WorkerRegistryStore,
    private readonly mirror: WorkerRegistryMirror,
  ) {}

  list(): Promise<WorkerRegistryEntry[]> {
    return this.inner.list();
  }

  get(id: string): Promise<WorkerRegistryEntry | null> {
    return this.inner.get(id);
  }

  async upsert(worker: WorkerRegistryEntry): Promise<WorkerRegistryEntry> {
    const saved = await this.inner.upsert(worker);
    this.mirror.upsert(saved);
    return saved;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.inner.remove(id);
    if (removed) this.mirror.unregister(id);
    return removed;
  }
}
