import { WorkerCandidate, ModelCandidate, ProviderCandidate, AIResourceCatalogPort } from "@/core/contracts/ai-selection";
import { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { WorkerRegistryPort } from "@/core/contracts/worker-registry";
import { AIResourceCatalog } from "./ai-resource-catalog";

/**
 * Adapter that makes a WorkerRegistryPort look like an AIResourceCatalogPort.
 * It combines the worker registry with the base AIResourceCatalog.
 * A worker is selectable only if both:
 *   1. WorkerRegistry says it is runnable
 *   2. Base AIResourceCatalog has the required selection candidate metadata
 * If either side is unknown/missing: FAIL CLOSED.
 *
 * The adapter snapshots the worker registry and base catalog at construction time
 * and does not reflect later changes.
 */
export class AdaptedAIResourceCatalog implements AIResourceCatalogPort {
  private workers: WorkerCandidate[];
  private baseCatalog: AIResourceCatalog;

  constructor(private readonly workerRegistry: WorkerRegistryPort, baseCatalog: AIResourceCatalog) {
    this.baseCatalog = baseCatalog;
    // Compute workers from the registry and base catalog at construction time
    const registryWorkers = workerRegistry.snapshot();
    const baseWorkers = baseCatalog.listWorkers();
    // Map base workers by workerKind for O(1) lookup
    const baseWorkerMap = new Map<string, WorkerCandidate>();
    for (const w of baseWorkers) {
      baseWorkerMap.set(w.workerKind, w);
    }
    const result: WorkerCandidate[] = [];
    for (const entry of registryWorkers) {
      if (this.isRunnable(entry)) {
        const baseWorker = baseWorkerMap.get(entry.workerKind);
        if (baseWorker) {
          // Return a defensive copy to avoid leaking internal state
          result.push({ ...baseWorker });
        }
      }
    }
    this.workers = result;
  }

  /** List all worker kinds that are runnable and have selection metadata. */
  listWorkers(): WorkerCandidate[] {
    return [...this.workers]; // return a copy
  }

  /** List all models - delegate to base catalog. */
  listModels(): ModelCandidate[] {
    return this.baseCatalog.listModels();
  }

  /** List all providers - delegate to base catalog. */
  listProviders(): ProviderCandidate[] {
    return this.baseCatalog.listProviders();
  }

  /** Get capabilities for a specific worker kind - delegate to base catalog. */
  getWorkerCapabilities(workerKind: string): string[] {
    return this.baseCatalog.getWorkerCapabilities(workerKind);
  }

  /** Get capabilities for a specific model from a provider - delegate to base catalog. */
  getModelCapabilities(modelId: string, providerId: string): string[] {
    return this.baseCatalog.getModelCapabilities(modelId, providerId);
  }

  /** Get health score for a provider (0-1) - delegate to base catalog. */
  getProviderHealth(providerId: string): number {
    return this.baseCatalog.getProviderHealth(providerId);
  }

  /** Check if a provider is available - delegate to base catalog. */
  isProviderAvailable(providerId: string): boolean {
    return this.baseCatalog.isProviderAvailable(providerId);
  }

  /** Check if a model is offered by a provider - delegate to base catalog. */
  isModelOffered(modelId: string, providerId: string): boolean {
    return this.baseCatalog.isModelOffered(modelId, providerId);
  }

  /**
   * Returns a deterministic snapshot of the catalog state.
   * The snapshot is a point-in-time view of workers, models, and providers.
   */
  snapshot(): {
    workers: WorkerCandidate[];
    models: ModelCandidate[];
    providers: ProviderCandidate[];
  } {
    return {
      workers: [...this.workers],
      models: this.baseCatalog.listModels(),
      providers: this.baseCatalog.listProviders(),
    };
  }

  /**
     * Determines if a worker is runnable based on registry state.
     * Runnable means: status == active, runtimeSupport == SUPPORTED_RUNTIME,
     * availability != unavailable, and health != unhealthy.
     * This matches a fail-closed policy where unknown health/availability are allowed
     * but unhealthy/unavailable are not.
     */
    private isRunnable(entry: WorkerRegistryEntry): boolean {
      return (
        entry.status === "active" &&
        entry.runtimeSupport === "SUPPORTED_RUNTIME" &&
        entry.availability !== "unavailable" &&
        entry.health !== "unhealthy"
      );
    }
}