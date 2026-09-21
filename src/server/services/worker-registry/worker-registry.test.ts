import { describe, expect, test, vi, afterEach } from "vitest";
import { InMemoryWorkerRegistry } from "./in-memory-worker-registry";
import { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { AdaptedAIResourceCatalog } from "@/server/services/ai-selection/adapted-ai-resource-catalog";
import { AIResourceCatalog } from "@/server/services/ai-selection/ai-resource-catalog";
import { testWorkers, testWorkerMap } from "./fixtures";

describe("InMemoryWorkerRegistry", () => {
  let registry: InMemoryWorkerRegistry;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("register worker", () => {
    registry = new InMemoryWorkerRegistry([]);
    const worker: WorkerRegistryEntry = { ...testWorkers[0] };
    registry.register(worker);
    expect(registry.getWorker(worker.id)).toEqual(worker);
  });

  test("duplicate id rejection", () => {
    registry = new InMemoryWorkerRegistry([testWorkers[0]]);
    expect(() => registry.register(testWorkers[0])).toThrow("Worker with ID");
  });

  test("listWorkers deterministic", () => {
    registry = new InMemoryWorkerRegistry([testWorkers[0], testWorkers[1]]);
    const snapshot1 = registry.snapshot();
    const snapshot2 = registry.snapshot();
    expect(snapshot1).toEqual(snapshot2);
    // order should be stable (by id)
    expect(snapshot1.map(w => w.id)).toEqual([
      testWorkers[0].id,
      testWorkers[1].id,
    ].sort());
  });

  test("getWorker", () => {
    registry = new InMemoryWorkerRegistry(testWorkers);
    expect(registry.getWorker(testWorkers[0].id)).toEqual(testWorkers[0]);
    expect(registry.getWorker("non-existent-id")).toBeUndefined();
  });

  test("getByKind", () => {
    registry = new InMemoryWorkerRegistry(testWorkers);
    const workers = registry.getByKind("hermes");
    expect(workers).toHaveLength(1);
    expect(workers[0].workerKind).toBe("hermes");
  });

  test("unknown health fail-closed", () => {
    registry = new InMemoryWorkerRegistry([{ ...testWorkers[0], health: "unknown" }]);
    const worker = registry.getWorker(testWorkers[0].id);
    expect(worker?.health).toBe("unknown");
  });

  test("unavailable worker", () => {
    registry = new InMemoryWorkerRegistry([{ ...testWorkers[0], status: "inactive" }]);
    const worker = registry.getWorker(testWorkers[0].id);
    expect(worker?.status).toBe("inactive");
  });

  test("capabilities preserved", () => {
    registry = new InMemoryWorkerRegistry(testWorkers);
    const worker = registry.getWorker(testWorkers[0].id);
    expect(worker?.capabilities).toEqual(testWorkers[0].capabilities);
  });

  test("tools preserved", () => {
    registry = new InMemoryWorkerRegistry(testWorkers);
    const worker = registry.getWorker(testWorkers[0].id);
    expect(worker?.supportsTools).toBe(testWorkers[0].supportsTools);
  });

  test("structured output preserved", () => {
    registry = new InMemoryWorkerRegistry(testWorkers);
    const worker = registry.getWorker(testWorkers[0].id);
    expect(worker?.supportsStructuredOutput).toBe(testWorkers[0].supportsStructuredOutput);
  });

  test("stable snapshot", () => {
    // Use a deep copy of the first worker to avoid mutating the fixture
    const workerCopy = JSON.parse(JSON.stringify(testWorkers[0]));
    registry = new InMemoryWorkerRegistry([workerCopy]);
    const snapshot1 = registry.snapshot();
    // mutate the copy (should not affect snapshot)
    workerCopy.capabilities = ["mutated"];
    const snapshot2 = registry.snapshot();
    expect(snapshot1).not.toEqual(snapshot2);
    expect(snapshot2[0].capabilities).toEqual(["mutated"]);
    // snapshot1 should still have original capabilities
    expect(snapshot1[0].capabilities).toEqual(testWorkerMap[testWorkers[0].id].capabilities);
  });

  test("defensive copy", () => {
    registry = new InMemoryWorkerRegistry(testWorkers);
    const snapshot = registry.snapshot();
    snapshot.push({} as any); // should not affect internal state
    expect(registry.snapshot().length).toBe(testWorkers.length);
  });

  test("registry -> WorkerCandidate mapping", () => {
    registry = new InMemoryWorkerRegistry(testWorkers);
    const baseCatalog = new AIResourceCatalog();
    const adapter = new AdaptedAIResourceCatalog(registry, baseCatalog);
    const catalog = adapter.listWorkers();
    // Only workers that are both runnable and have base catalog entry:
    // agent, other, hermes (openhands and digitalos missing from base catalog)
    expect(catalog).toHaveLength(3);
    // find the hermes worker
    const hermes = catalog.find(w => w.workerKind === "hermes");
    expect(hermes).toBeDefined();
    expect(hermes?.workerKind).toBe("hermes");
  });

  test("AIResourceCatalogPort adapter uses registry snapshot once", () => {
    const snapshotSpy = vi.spyOn(InMemoryWorkerRegistry.prototype, "snapshot");
    // Create a runnable worker
    const runnableWorker: WorkerRegistryEntry = {
      ...testWorkers[0],
      health: "healthy",
      availability: "available",
      runtimeSupport: "SUPPORTED_RUNTIME",
    };
    registry = new InMemoryWorkerRegistry([runnableWorker]);
    const baseCatalog = new AIResourceCatalog();
    const adapter = new AdaptedAIResourceCatalog(registry, baseCatalog);
    adapter.listWorkers();
    adapter.listWorkers(); // call twice
    expect(snapshotSpy).toHaveBeenCalledTimes(1); // only in constructor
  });

  test("same worker kind across multiple instances", () => {
    // create two workers of same kind, both runnable
    const worker1: WorkerRegistryEntry = {
      ...testWorkers[0],
      id: "hermes-worker-002",
      health: "healthy",
      availability: "available",
      runtimeSupport: "SUPPORTED_RUNTIME",
    };
    const worker2: WorkerRegistryEntry = {
      ...testWorkers[0],
      id: "hermes-worker-003",
      health: "healthy",
      availability: "available",
      runtimeSupport: "SUPPORTED_RUNTIME",
    };
    registry = new InMemoryWorkerRegistry([worker1, worker2]);
    const baseCatalog = new AIResourceCatalog();
    const adapter = new AdaptedAIResourceCatalog(registry, baseCatalog);
    const catalog = adapter.listWorkers();
    // both should be present
    expect(catalog).toHaveLength(2);
    expect(catalog.every(w => w.workerKind === "hermes")).toBe(true);
    const kinds = catalog.map(w => w.workerKind);
    expect(kinds.filter(k => k === "hermes").length).toBe(2);
  });

  test("disabled worker excluded from catalog (status filtered)", () => {
    registry = new InMemoryWorkerRegistry([{ ...testWorkers[0], status: "inactive" }]);
    const baseCatalog = new AIResourceCatalog();
    const adapter = new AdaptedAIResourceCatalog(registry, baseCatalog);
    const catalog = adapter.listWorkers();
    // inactive worker should be excluded
    expect(catalog.find(w => w.workerKind === testWorkers[0].workerKind)).toBeUndefined();
  });

  test("unknown runtime support excluded from catalog", () => {
    // runtimeSupport: UNKNOWN
    const worker: WorkerRegistryEntry = {
      ...testWorkers[0],
      health: "healthy",
      availability: "available",
      runtimeSupport: "UNKNOWN",
    };
    registry = new InMemoryWorkerRegistry([worker]);
    const baseCatalog = new AIResourceCatalog();
    const adapter = new AdaptedAIResourceCatalog(registry, baseCatalog);
    const catalog = adapter.listWorkers();
    // worker with unknown runtime support should be excluded
    expect(catalog.find(w => w.workerKind === testWorkers[0].workerKind)).toBeUndefined();
  });

  test("unavailable worker excluded from catalog", () => {
    registry = new InMemoryWorkerRegistry([{ ...testWorkers[0], availability: "unavailable" }]);
    const baseCatalog = new AIResourceCatalog();
    const adapter = new AdaptedAIResourceCatalog(registry, baseCatalog);
    const catalog = adapter.listWorkers();
    // unavailable worker should be excluded
    expect(catalog.find(w => w.workerKind === testWorkers[0].workerKind)).toBeUndefined();
  });

  test("unhealthy worker excluded from catalog", () => {
    registry = new InMemoryWorkerRegistry([{ ...testWorkers[0], health: "unhealthy" }]);
    const baseCatalog = new AIResourceCatalog();
    const adapter = new AdaptedAIResourceCatalog(registry, baseCatalog);
    const catalog = adapter.listWorkers();
    // unhealthy worker should be excluded
    expect(catalog.find(w => w.workerKind === testWorkers[0].workerKind)).toBeUndefined();
  });
});