import {
  workerRegistryEntrySchema,
  type WorkerAvailability,
  type WorkerHealth,
  type WorkerProbeOutcome,
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
  /**
   * Declared concurrency (M5.5). Defaults to 1 — a worker is not an unlimited
   * execution slot. This IS a legitimate self-declaration, unlike health: how
   * many jobs a worker can hold is a property of its configuration, not an
   * observation about whether it currently works.
   */
  maxConcurrency?: number;
  /** Shared capacity pool this worker draws from, e.g. one provider account. */
  capacityPool?: string | null;
  /** Concurrent executions the whole pool may hold. */
  capacityPoolLimit?: number | null;
}

export interface WorkerProbe {
  health: WorkerHealth;
  availability: WorkerAvailability;
  /**
   * What the probe did (M5.2). Defaults to "ok" because the only caller that
   * omits it is a caller reporting a successful observation. A FAILED probe
   * must say so: collapsing a failure into "no evidence" hides the difference
   * between "we could not reach it" and "we have not looked yet", and a
   * provider/runtime probe failure that reads as absence is a failure that
   * passed silently.
   */
  outcome?: WorkerProbeOutcome;
}

/**
 * The DECLARATION fields of a worker — everything registration owns, and nothing
 * a probe owns.
 *
 * Exported because two callers must agree on it or they disagree about what
 * "already registered" means: `register()` uses it to decide whether a
 * re-registration is a no-op, and the compute bootstrap planner uses it to
 * classify a candidate as WOULD_UPDATE rather than WOULD_REGISTER. Two
 * independent notions of "same declaration" would make a dry-run report say one
 * thing and the write do another.
 *
 * `status` is IN, deliberately: registering a deactivated worker is a change (it
 * comes back as `active`), and must therefore reset evidence like any other
 * change. `updatedAt`, `health`, `availability`, `lastProbeAt` and
 * `lastProbeOutcome` are OUT: they are observations, not declarations.
 *
 * `metadata` KEYS ARE SORTED, and that is not cosmetic. PostgreSQL `jsonb` does not
 * preserve object key order, so a declaration read back from the durable store is
 * key-reordered relative to the one that wrote it. Comparing unsorted would make every
 * re-registration look like a change AGAINST A REAL DATABASE while passing against an
 * in-memory store — the no-op would never fire where it matters, and a restart would
 * still wipe the fleet's probe evidence. Array order is left alone: `jsonb` preserves
 * it, and capability order is part of the declaration.
 */
export function workerDeclaration(
  input: WorkerRegistrationInput | WorkerRegistryEntry,
): Record<string, unknown> {
  const entry = input as Partial<WorkerRegistryEntry> & WorkerRegistrationInput;
  return {
    workerKind: entry.workerKind,
    displayName: entry.displayName,
    capabilities: entry.capabilities ?? [],
    features: entry.features ?? [],
    supportsTools: entry.supportsTools ?? false,
    supportsStructuredOutput: entry.supportsStructuredOutput ?? false,
    status: entry.status ?? "active",
    runtime: entry.runtime ?? "unknown",
    runtimeSupport: entry.runtimeSupport ?? "UNKNOWN",
    tags: entry.tags ?? [],
    metadata: Object.fromEntries(Object.entries(entry.metadata ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    maxConcurrency: entry.maxConcurrency ?? 1,
    capacityPool: entry.capacityPool ?? null,
    capacityPoolLimit: entry.capacityPoolLimit ?? null,
  };
}

/** True when two declarations are identical. Field order is fixed by `workerDeclaration`. */
export function sameWorkerDeclaration(
  a: WorkerRegistrationInput | WorkerRegistryEntry,
  b: WorkerRegistrationInput | WorkerRegistryEntry,
): boolean {
  return JSON.stringify(workerDeclaration(a)) === JSON.stringify(workerDeclaration(b));
}

export class WorkerRegistrationService {
  constructor(
    private readonly workers: WorkerRegistryStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Registers or re-registers a worker in the fail-closed state.
   *
   * Re-registering an existing worker with a CHANGED declaration RESETS its
   * health, availability AND its probe evidence: the declaration changed, so
   * previous probe evidence no longer describes the thing that is registered now.
   *
   * RE-REGISTERING AN UNCHANGED DECLARATION IS A NO-OP (live-worker bootstrap).
   * It returns the stored row untouched — same evidence, same `updatedAt`.
   * Without this, any bootstrap that registers the declared fleet on every boot
   * would wipe the whole fleet's health evidence at every restart and on every
   * replica, so a restart would silently make a proven fleet unroutable until the
   * next probe sweep. Resetting evidence is the right answer to a CHANGE, never
   * to a repetition: idempotency here is not an optimisation, it is what makes a
   * startup bootstrap safe to run unconditionally.
   */
  async register(input: WorkerRegistrationInput): Promise<WorkerRegistryEntry> {
    const existing = await this.workers.get(input.id);
    if (existing && sameWorkerDeclaration(existing, input)) {
      return existing;
    }

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
      lastProbeAt: null,
      lastProbeOutcome: "never",
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      maxConcurrency: input.maxConcurrency ?? 1,
      capacityPool: input.capacityPool ?? null,
      capacityPoolLimit: input.capacityPoolLimit ?? null,
      updatedAt: this.now().toISOString(),
    });

    return this.workers.upsert(entry);
  }

  /**
   * Records DATED probe evidence. Returns null for an unregistered worker
   * rather than inventing one — a probe result for a worker nobody registered
   * is a bug upstream, not a registration.
   *
   * `lastProbeAt` is stamped here and nowhere else. That is what makes health
   * evidence ageable, and therefore expirable: see
   * WorkerHealthProber.expireStaleEvidence and the HEALTH_EVIDENCE_STALE gate
   * in the canonical matcher.
   */
  async probe(workerId: string, probe: WorkerProbe): Promise<WorkerRegistryEntry | null> {
    const existing = await this.workers.get(workerId);
    if (!existing) {
      return null;
    }

    const at = this.now().toISOString();

    return this.workers.upsert({
      ...existing,
      health: probe.health,
      availability: probe.availability,
      lastProbeAt: at,
      lastProbeOutcome: probe.outcome ?? "ok",
      updatedAt: at,
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

  /**
   * Re-activates a worker (control command ENABLE_WORKER, decision 0055).
   *
   * Like registration, re-activation is NOT a health claim: evidence is reset to
   * "never probed", so the canonical matcher routes nothing to this worker until
   * a real probe succeeds again. Old evidence from before the disable is never
   * trusted.
   */
  async reactivate(workerId: string): Promise<WorkerRegistryEntry | null> {
    const existing = await this.workers.get(workerId);
    if (!existing) {
      return null;
    }

    return this.workers.upsert({
      ...existing,
      status: "active",
      health: "unknown",
      availability: "unknown",
      lastProbeAt: null,
      lastProbeOutcome: "never",
      updatedAt: this.now().toISOString(),
    });
  }

  /** Forgets a worker entirely. Returns true if a row was removed. */
  async deregister(workerId: string): Promise<boolean> {
    return this.workers.remove(workerId);
  }
}
