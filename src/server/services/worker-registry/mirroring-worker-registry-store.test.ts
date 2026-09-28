import { describe, expect, it } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { InMemoryWorkerRegistry } from "./in-memory-worker-registry";
import { MirroringWorkerRegistryStore } from "./mirroring-worker-registry-store";

const worker = (id: string, over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry =>
  ({
    id,
    workerKind: "agent",
    displayName: id,
    capabilities: [],
    features: [],
    supportsTools: false,
    supportsStructuredOutput: false,
    status: "active",
    runtime: "binary",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "unknown",
    availability: "unknown",
    lastProbeAt: null,
    lastProbeOutcome: "never",
    tags: [],
    metadata: {},
    maxConcurrency: 1,
    capacityPool: null,
    capacityPoolLimit: null,
    updatedAt: new Date().toISOString(),
    ...over,
  }) as WorkerRegistryEntry;

describe("MirroringWorkerRegistryStore (defect 31)", () => {
  const compose = () => {
    const view = new InMemoryWorkerRegistry([]);
    return { view, store: new MirroringWorkerRegistryStore(new InMemoryWorkerRegistryStore(), view) };
  };

  it("A WORKER REGISTERED AFTER BOOT IS VISIBLE to the synchronous fleet view", async () => {
    const { view, store } = compose();
    /* The boot-time snapshot this replaces would still be empty here — for ever. */
    expect(view.listWorkers()).toHaveLength(0);

    await store.upsert(worker("w1"));

    expect(view.listWorkers().map((w) => w.id)).toEqual(["w1"]);
  });

  it("FOLLOWS PROBE EVIDENCE, not only registration — routing depends on it", async () => {
    const { view, store } = compose();
    await store.upsert(worker("w1"));

    await store.upsert(worker("w1", { health: "healthy", availability: "available" }));

    expect(view.listWorkers()).toHaveLength(1);
    expect(view.getWorker("w1")?.health).toBe("healthy");
  });

  it("forgets a removed worker, and leaves the view alone when nothing was removed", async () => {
    const { view, store } = compose();
    await store.upsert(worker("w1"));

    expect(await store.remove("absent")).toBe(false);
    expect(view.listWorkers()).toHaveLength(1);

    expect(await store.remove("w1")).toBe(true);
    expect(view.listWorkers()).toHaveLength(0);
  });

  it("mirrors only AFTER the durable write succeeds: the store stays the source of truth", async () => {
    const view = new InMemoryWorkerRegistry([]);
    const failing = {
      list: async () => [],
      get: async () => null,
      upsert: async () => {
        throw new Error("DURABLE_WRITE_FAILED");
      },
      remove: async () => {
        throw new Error("DURABLE_WRITE_FAILED");
      },
    };
    const store = new MirroringWorkerRegistryStore(failing, view);

    await expect(store.upsert(worker("w1"))).rejects.toThrow("DURABLE_WRITE_FAILED");

    expect(view.listWorkers()).toHaveLength(0);
  });
});
