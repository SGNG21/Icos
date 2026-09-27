import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

/**
 * Durable store behind the worker registry (decision 0031).
 *
 * Deliberately async and deliberately SEPARATE from `WorkerRegistryPort`,
 * which stays synchronous. The registry is the read model every matcher
 * already consumes; this is the durable state it is hydrated from. Making
 * WorkerRegistryPort async instead would have rippled through
 * IndependentReviewerSelector, BoundedRepairController and
 * AdaptedAIResourceCatalog for no routing benefit.
 */
export interface WorkerRegistryStore {
  /** Every registered worker, ordered by id. Deterministic. */
  list(): Promise<WorkerRegistryEntry[]>;
  get(id: string): Promise<WorkerRegistryEntry | null>;
  /** Insert or replace a worker. Registration and health/availability probes both land here. */
  upsert(worker: WorkerRegistryEntry): Promise<WorkerRegistryEntry>;
  /** Returns true if a row was removed. */
  remove(id: string): Promise<boolean>;
}
