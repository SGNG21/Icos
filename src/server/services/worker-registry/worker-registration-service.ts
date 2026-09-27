import {
  workerRegistryEntrySchema,
  type WorkerAvailability,
  type WorkerHealth,
  type WorkerRegistryEntry,
} from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";

/**
 * Worker registration and probing (M5).
 *
 * M4 built a durable registry and a fail-closed matcher, but nothing ever
 * WROTE a worker, so every deployment sat in ROUTING_UNCONFIGURED and
 * capability routing — though proven — was inert. This is the write side.
 *
 * REGISTRATION IS NOT A HEALTH CLAIM. `register()` deliberately refuses to
 * accept health or availability from the caller: a worker announcing itself is
 * evidence that it EXISTS, not evidence that it WORKS. A newly registered
 * worker is therefore `health: "unknown"`, `availability: "unknown"` and routes
 * nothing until a probe proves otherwise. Letting registration assert
 * "healthy" would reintroduce, at the write boundary, exactly the fail-open
 * hole decision 0031 closed at the read boundary.
 */
export interface WorkerRegistrationInput {
  id: string;
  workerKind: string;
  displayName: string;
  capabilities?: string[];
  features?: string[];
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  runtime?: WorkerRegistryEntry["runtime"];
  /**
   * Whether this runtime is actually supported HERE. Defaults to UNKNOWN:
   * declaring a runtime is not the same as being able to run it.
   */
  runtimeSupport?: WorkerRegistryEntry["runtimeSupport"];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface WorkerProbe {
  health: WorkerHealth;
  availability: WorkerAvailability;
}

export class WorkerRegistrationService {
  constructor(
    private readonly workers: WorkerRegistryStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Registers or re-registers a worker in the fail-closed state.
   *
   * Re-registering an existing worker RESETS its health and availability to
   * unknown: the declaration changed, so previous probe evidence no longer
   * describes the thing that is registered now.
   */
  async register(input: WorkerRegistrationInput): Promise<WorkerRegistryEntry> {
    const entry = workerRegistryEntrySchema.parse({
      id: input.id,
      workerKind: input.workerKind,
      displayName: input.displayName,
      capabilities: input.capabilities ?? [],
      features: input.features ?? [],
      supportsTools: input.supportsTools ?? false,
      supportsStructuredOutput: input.supportsStructuredOutput ?? false,
      status: "active",
      runtime: input.runtime ?? "unknown",
      runtimeSupport: input.runtimeSupport ?? "UNKNOWN",
      health: "unknown",
      availability: "unknown",
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      updatedAt: this.now().toISOString(),
    });

    return this.workers.upsert(entry);
  }

  /**
   * Records probe evidence. Returns null for an unregistered worker rather
   * than inventing one — a probe result for a worker nobody registered is a
   * bug upstream, not a registration.
   */
  async probe(workerId: string, probe: WorkerProbe): Promise<WorkerRegistryEntry | null> {
    const existing = await this.workers.get(workerId);
    if (!existing) {
      return null;
    }

    return this.workers.upsert({
      ...existing,
      health: probe.health,
      availability: probe.availability,
      updatedAt: this.now().toISOString(),
    });
  }

  /**
   * Takes a worker out of rotation without forgetting it, preserving its
   * capability declaration and its last probe for audit.
   */
  async deactivate(workerId: string): Promise<WorkerRegistryEntry | null> {
    const existing = await this.workers.get(workerId);
    if (!existing) {
      return null;
    }

    return this.workers.upsert({
      ...existing,
      status: "inactive",
      updatedAt: this.now().toISOString(),
    });
  }

  /** Forgets a worker entirely. Returns true if a row was removed. */
  async deregister(workerId: string): Promise<boolean> {
    return this.workers.remove(workerId);
  }
}
