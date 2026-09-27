import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import {
  evaluateWorkerEligibility,
  evaluateWorkerPool,
  selectEligibleWorkers,
  selectWorker,
} from "@/core/workers/worker-eligibility";

/**
 * M4 CAPABILITY ROUTING — proofs for the canonical eligibility authority.
 *
 * Every one of these was mutation-verified: the corresponding gate was
 * deliberately removed from worker-eligibility.ts and the test failed.
 */

/** A worker that passes every gate. Tests degrade it one field at a time. */
function worker(overrides: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry {
  return {
    id: "worker-b",
    workerKind: "agent",
    displayName: "Eligible Worker",
    capabilities: ["code-generation", "testing"],
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
    ...overrides,
  };
}

describe("canonical worker eligibility", () => {
  it("BASELINE_ELIGIBLE: a fully probed, active, capable worker is eligible", () => {
    const verdict = evaluateWorkerEligibility(worker(), {
      requiredCapabilities: ["code-generation"],
    });

    expect(verdict.eligible).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.missingCapabilities).toEqual([]);
  });

  describe("INACTIVE_UNHEALTHY_UNAVAILABLE_REJECTED (M4.3)", () => {
    const rejected: Array<[string, Partial<WorkerRegistryEntry>, string]> = [
      ["inactive", { status: "inactive" }, "STATUS_NOT_ACTIVE"],
      ["maintenance", { status: "maintenance" }, "STATUS_NOT_ACTIVE"],
      ["unhealthy", { health: "unhealthy" }, "HEALTH_NOT_HEALTHY"],
      ["degraded", { health: "degraded" }, "HEALTH_NOT_HEALTHY"],
      ["unavailable", { availability: "unavailable" }, "NOT_AVAILABLE"],
      ["declared-only runtime", { runtimeSupport: "DECLARED_ONLY" }, "RUNTIME_NOT_SUPPORTED"],
    ];

    for (const [label, mutation, reason] of rejected) {
      it(`rejects a ${label} worker`, () => {
        const verdict = evaluateWorkerEligibility(worker(mutation));
        expect(verdict.eligible).toBe(false);
        expect(verdict.reasons).toContain(reason);
      });
    }
  });

  describe("UNKNOWN_FAILS_CLOSED (M4.5)", () => {
    it("rejects unknown health", () => {
      expect(evaluateWorkerEligibility(worker({ health: "unknown" })).eligible).toBe(false);
    });

    it("rejects unknown availability", () => {
      expect(evaluateWorkerEligibility(worker({ availability: "unknown" })).eligible).toBe(false);
    });

    it("rejects unknown runtime support", () => {
      expect(evaluateWorkerEligibility(worker({ runtimeSupport: "UNKNOWN" })).eligible).toBe(false);
    });

    it("an entirely unprobed worker is rejected and says exactly why", () => {
      const verdict = evaluateWorkerEligibility(
        worker({ health: "unknown", availability: "unknown", runtimeSupport: "UNKNOWN" }),
      );

      expect(verdict.eligible).toBe(false);
      expect(verdict.reasons).toEqual([
        "RUNTIME_NOT_SUPPORTED",
        "HEALTH_NOT_HEALTHY",
        "NOT_AVAILABLE",
      ]);
    });
  });

  describe("MISSING_CAPABILITY_REJECTED (M4.4)", () => {
    it("rejects a worker missing ANY one required capability", () => {
      const verdict = evaluateWorkerEligibility(worker(), {
        requiredCapabilities: ["code-generation", "deep-research"],
      });

      expect(verdict.eligible).toBe(false);
      expect(verdict.reasons).toContain("MISSING_REQUIRED_CAPABILITIES");
      expect(verdict.missingCapabilities).toEqual(["deep-research"]);
    });

    it("requires ALL, not ANY", () => {
      expect(
        evaluateWorkerEligibility(worker(), {
          requiredCapabilities: ["code-generation", "testing"],
        }).eligible,
      ).toBe(true);
    });

    it("a worker with no capabilities cannot satisfy a non-empty requirement", () => {
      expect(
        evaluateWorkerEligibility(worker({ capabilities: [] }), {
          requiredCapabilities: ["code-generation"],
        }).eligible,
      ).toBe(false);
    });

    it("an empty requirement imposes no capability constraint", () => {
      expect(
        evaluateWorkerEligibility(worker({ capabilities: [] }), { requiredCapabilities: [] })
          .eligible,
      ).toBe(true);
    });

    it("reports missing capabilities deduplicated and sorted", () => {
      const verdict = evaluateWorkerEligibility(worker(), {
        requiredCapabilities: ["zeta", "alpha", "zeta"],
      });

      expect(verdict.missingCapabilities).toEqual(["alpha", "zeta"]);
    });

    it("capability matching is exact, never a prefix or substring", () => {
      expect(
        evaluateWorkerEligibility(worker({ capabilities: ["website.build"] }), {
          requiredCapabilities: ["website"],
        }).eligible,
      ).toBe(false);
    });
  });

  describe("worker kind and exclusion filters", () => {
    it("rejects a worker of the wrong kind", () => {
      const verdict = evaluateWorkerEligibility(worker(), { workerKind: "hermes" });
      expect(verdict.eligible).toBe(false);
      expect(verdict.reasons).toContain("WORKER_KIND_MISMATCH");
    });

    it("rejects an explicitly excluded worker (self-review / burnt retry)", () => {
      const verdict = evaluateWorkerEligibility(worker(), { excludeWorkerIds: ["worker-b"] });
      expect(verdict.eligible).toBe(false);
      expect(verdict.reasons).toContain("EXCLUDED_WORKER");
    });
  });

  describe("DETERMINISTIC_SELECTION (M4.6)", () => {
    const a = worker({ id: "worker-a" });
    const b = worker({ id: "worker-b" });
    const c = worker({ id: "worker-c" });

    it("picks the same worker whatever the input order", () => {
      const orders = [
        [a, b, c],
        [c, b, a],
        [b, c, a],
        [c, a, b],
      ];

      for (const order of orders) {
        expect(selectWorker(order)?.id).toBe("worker-a");
      }
    });

    it("returns equivalent candidates in a stable order", () => {
      expect(selectEligibleWorkers([c, a, b]).map((w) => w.id)).toEqual([
        "worker-a",
        "worker-b",
        "worker-c",
      ]);
    });

    it("returns null rather than guessing when nothing is eligible", () => {
      expect(selectWorker([worker({ health: "unknown" })])).toBeNull();
      expect(selectWorker([])).toBeNull();
    });

    it("pool verdicts are complete and stably ordered — every refusal is evidence", () => {
      const verdicts = evaluateWorkerPool([c, worker({ id: "worker-x", health: "unknown" }), a], {
        requiredCapabilities: ["code-generation"],
      });

      expect(verdicts.map((v) => v.workerId)).toEqual(["worker-a", "worker-c", "worker-x"]);
      expect(verdicts.filter((v) => v.eligible).map((v) => v.workerId)).toEqual([
        "worker-a",
        "worker-c",
      ]);
    });
  });

  describe("NO_PROVIDER_HARDWIRE (M4.7)", () => {
    it("the routing authority names no model, provider or account", () => {
      const source = readFileSync(
        resolve(process.cwd(), "src/core/workers/worker-eligibility.ts"),
        "utf8",
      );

      for (const forbidden of [
        "nemotron",
        "codex",
        "anthropic",
        "openai",
        "gpt-",
        "gemini",
        "claude-",
        "mistral",
      ]) {
        expect(source.toLowerCase()).not.toContain(forbidden);
      }
    });

    it("routes purely on registry data — a novel worker kind needs no code change", () => {
      const unknownFuture = worker({
        id: "worker-from-the-future",
        workerKind: "other",
        capabilities: ["quantum.compile"],
      });

      expect(
        selectWorker([unknownFuture], { requiredCapabilities: ["quantum.compile"] })?.id,
      ).toBe("worker-from-the-future");
    });
  });
});
