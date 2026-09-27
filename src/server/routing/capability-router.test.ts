import { describe, expect, it } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { CapabilityRouter } from "@/server/routing/capability-router";

/*
 * M4 — capability routing (decision 0031).
 *
 * The router owns no matching logic; these prove the routing CONTRACT around
 * the canonical matcher: what an empty registry means, that a refusal is
 * explained, and that equivalent candidates resolve deterministically.
 */

function worker(over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry {
  return {
    lastProbeAt: new Date().toISOString(),
    lastProbeOutcome: "ok",
    id: "worker-b",
    workerKind: "agent",
    displayName: "Worker",
    capabilities: ["code-generation"],
    features: [],
    supportsTools: true,
    supportsStructuredOutput: true,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    tags: [],
    metadata: {},
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...over,
  };
}

const routerOver = (workers: WorkerRegistryEntry[]) =>
  new CapabilityRouter(new InMemoryWorkerRegistryStore(workers));

describe("capability router", () => {
  it("ROUTING_UNCONFIGURED: an empty registry is not a routing table", async () => {
    const result = await routerOver([]).route({ requiredCapabilities: ["code-generation"] });

    expect(result.decision).toBe("ROUTING_UNCONFIGURED");
    expect(result.worker).toBeNull();
  });

  it("ROUTED: a capable, probed worker wins", async () => {
    const result = await routerOver([worker()]).route({ requiredCapabilities: ["code-generation"] });

    expect(result.decision).toBe("ROUTED");
    expect(result.worker?.id).toBe("worker-b");
  });

  describe("a NON-EMPTY registry is authoritative and fails closed", () => {
    it("refuses when no worker has the required capability", async () => {
      const result = await routerOver([worker()]).route({ requiredCapabilities: ["deep-research"] });

      expect(result.decision).toBe("NO_ELIGIBLE_WORKER");
      expect(result.worker).toBeNull();
    });

    it("refuses when the only capable worker is unprobed (UNKNOWN fails closed)", async () => {
      const result = await routerOver([worker({ health: "unknown" })]).route({
        requiredCapabilities: ["code-generation"],
      });

      expect(result.decision).toBe("NO_ELIGIBLE_WORKER");
    });

    it("refuses when the only capable worker is inactive or unavailable", async () => {
      for (const broken of [{ status: "inactive" as const }, { availability: "unavailable" as const }]) {
        expect((await routerOver([worker(broken)]).route({})).decision).toBe("NO_ELIGIBLE_WORKER");
      }
    });

    it("explains every refusal per candidate — a refusal without evidence is not auditable", async () => {
      const result = await routerOver([
        worker({ id: "worker-a", health: "unknown" }),
        worker({ id: "worker-c", capabilities: [] }),
      ]).route({ requiredCapabilities: ["code-generation"] });

      expect(result.decision).toBe("NO_ELIGIBLE_WORKER");
      expect(result.candidates.map((c) => c.workerId)).toEqual(["worker-a", "worker-c"]);
      expect(result.candidates[0].reasons).toContain("HEALTH_NOT_HEALTHY");
      expect(result.candidates[1].reasons).toContain("MISSING_REQUIRED_CAPABILITIES");
      expect(result.candidates[1].missingCapabilities).toEqual(["code-generation"]);
    });
  });

  it("honours workerKind as a hard filter", async () => {
    const registry = [worker({ id: "worker-a", workerKind: "hermes" }), worker({ id: "worker-b" })];

    expect((await routerOver(registry).route({ workerKind: "hermes" })).worker?.id).toBe("worker-a");
    expect((await routerOver(registry).route({ workerKind: "digitalos" })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("DETERMINISTIC: equivalent candidates resolve identically whatever the registry order", async () => {
    const a = worker({ id: "worker-a" });
    const b = worker({ id: "worker-b" });
    const c = worker({ id: "worker-c" });

    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) {
      expect((await routerOver(order).route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(
        "worker-a",
      );
    }
  });
});
