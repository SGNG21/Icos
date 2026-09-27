import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import {
  evaluateWorkerEligibility,
  evaluateWorkerPool,
  selectEligibleWorkers,
  selectWorker,
  computeWorkerLoad,
  effectiveCapacityPoolLimits,
} from "@/core/workers/worker-eligibility";

/**
 * M4 CAPABILITY ROUTING — proofs for the canonical eligibility authority.
 *
 * Every one of these was mutation-verified: the corresponding gate was
 * deliberately removed from worker-eligibility.ts and the test failed.
 */

/** Fresh probe evidence. M5.2: `healthy` alone is not eligibility. */
const PROBED_AT = "2026-09-27T12:00:00.000Z";

/** A worker that passes every gate. Tests degrade it one field at a time. */
function worker(overrides: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry {
  return {
    id: "worker-b",
    workerKind: "agent",
    displayName: "Eligible Worker",
    maxConcurrency: 1,
    capacityPool: null,
    capacityPoolLimit: null,
    lastProbeAt: PROBED_AT,
    lastProbeOutcome: "ok",
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

/*
 * M5.2 HEALTH EVIDENCE FRESHNESS.
 *
 * `health: "healthy"` is a CLAIM. What makes it evidence is a probe timestamp
 * that can be aged. These gates were mutation-verified: deleting the
 * evidenceHorizon block from worker-eligibility.ts makes every test below fail.
 */
describe("M5.2 health evidence freshness", () => {
  const NOW = "2026-09-27T12:00:00.000Z";
  const horizon = { now: NOW, maxAgeMs: 60_000 };

  it("HEALTH_EVIDENCE_MISSING: a healthy worker that was never probed is refused", () => {
    const verdict = evaluateWorkerEligibility(
      worker({ health: "healthy", lastProbeAt: null, lastProbeOutcome: "never" }),
      { evidenceHorizon: horizon },
    );

    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("HEALTH_EVIDENCE_MISSING");
  });

  it("HEALTH_EVIDENCE_STALE: evidence older than the horizon is refused", () => {
    const verdict = evaluateWorkerEligibility(
      worker({ lastProbeAt: "2026-09-27T11:58:59.000Z" }),
      { evidenceHorizon: horizon },
    );

    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("HEALTH_EVIDENCE_STALE");
  });

  it("evidence exactly at the horizon is still fresh; one millisecond past is not", () => {
    const atLimit = evaluateWorkerEligibility(worker({ lastProbeAt: "2026-09-27T11:59:00.000Z" }), {
      evidenceHorizon: horizon,
    });
    const pastLimit = evaluateWorkerEligibility(
      worker({ lastProbeAt: "2026-09-27T11:58:59.999Z" }),
      { evidenceHorizon: horizon },
    );

    expect(atLimit.eligible).toBe(true);
    expect(pastLimit.reasons).toContain("HEALTH_EVIDENCE_STALE");
  });

  it("an unparseable probe timestamp is STALE, never fresh", () => {
    const verdict = evaluateWorkerEligibility(worker({ lastProbeAt: "not-a-date" }), {
      evidenceHorizon: horizon,
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("HEALTH_EVIDENCE_STALE");
  });

  it("fresh evidence plus every other gate passing is eligible", () => {
    expect(
      evaluateWorkerEligibility(worker({ lastProbeAt: NOW }), { evidenceHorizon: horizon })
        .eligible,
    ).toBe(true);
  });

  it("freshness NEVER rescues an unhealthy worker: the gates are cumulative", () => {
    const verdict = evaluateWorkerEligibility(
      worker({ health: "unhealthy", lastProbeAt: NOW }),
      { evidenceHorizon: horizon },
    );

    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("HEALTH_NOT_HEALTHY");
  });

  it("stale evidence is refused by selectWorker, not merely reported", () => {
    const fresh = worker({ id: "worker-fresh", lastProbeAt: NOW });
    const stale = worker({ id: "worker-aaa-stale", lastProbeAt: "2026-01-01T00:00:00.000Z" });

    // worker-aaa-stale sorts FIRST by id: without the gate it would win.
    expect(selectWorker([stale, fresh], { evidenceHorizon: horizon })?.id).toBe("worker-fresh");
    expect(selectWorker([stale], { evidenceHorizon: horizon })).toBeNull();
  });

  it("is a pure function of (worker, now): the same inputs replay identically", () => {
    const w = worker({ lastProbeAt: "2026-09-27T11:59:30.000Z" });
    const first = evaluateWorkerEligibility(w, { evidenceHorizon: horizon });
    const second = evaluateWorkerEligibility(w, { evidenceHorizon: horizon });

    expect(second).toEqual(first);
  });
});

/*
 * M5.3 DURABLE DISTRIBUTION + M5.5 CAPACITY.
 *
 * Mutation-verified. The point of every test here is that the policy is a PURE
 * FUNCTION OF DURABLE STATE: same rows in, same assignment out, before and after
 * a restart. No clock, no counter, no randomness.
 */
describe("M5.3 durable distribution", () => {
  const HORIZON = { now: "2026-09-27T12:00:00.000Z", maxAgeMs: 60_000 };

  function pool(...ids: string[]): WorkerRegistryEntry[] {
    return ids.map((id) => worker({ id }));
  }

  it("DISTRIBUTION: the least-loaded eligible worker wins, not the lowest id", () => {
    // Concurrency 3 so load ORDERING is what is under test, not the capacity gate.
    const workers = ["worker-a", "worker-b", "worker-c"].map((id) =>
      worker({ id, maxConcurrency: 3 }),
    );
    const load = computeWorkerLoad(["worker-a", "worker-a", "worker-b"], workers);

    // worker-a sorts first by id and would win without the policy.
    expect(
      selectEligibleWorkers(workers, { load, evidenceHorizon: HORIZON }).map((w) => w.id),
    ).toEqual(["worker-c", "worker-b", "worker-a"]);
    expect(selectWorker(workers, { load, evidenceHorizon: HORIZON })?.id).toBe("worker-c");
  });

  it("DETERMINISTIC_TIE_BREAK: equal load resolves by worker id, every time", () => {
    const workers = pool("worker-c", "worker-a", "worker-b");
    const load = computeWorkerLoad([], workers);

    const first = selectEligibleWorkers(workers, { load, evidenceHorizon: HORIZON });
    const second = selectEligibleWorkers([...workers].reverse(), { load, evidenceHorizon: HORIZON });

    expect(first.map((w) => w.id)).toEqual(["worker-a", "worker-b", "worker-c"]);
    expect(second.map((w) => w.id)).toEqual(first.map((w) => w.id));
  });

  /** Routes `count` tasks the way the supervisor does: decide, record, re-derive. */
  function routeMany(
    count: number,
    workers: readonly WorkerRegistryEntry[],
  ): { assignments: string[]; refused: number } {
    const assignments: string[] = [];
    let refused = 0;

    for (let i = 0; i < count; i += 1) {
      const chosen = selectWorker(workers, {
        load: computeWorkerLoad(assignments, workers),
        evidenceHorizon: HORIZON,
      });
      if (chosen) {
        assignments.push(chosen.id);
      } else {
        refused += 1;
      }
    }

    return { assignments, refused };
  }

  it("MULTIWORKER_DISTRIBUTION_PROVEN: 10 ready tasks, 3 single-slot workers, no piling up", () => {
    const workers = ["worker-a", "worker-b", "worker-c"].map((id) => worker({ id }));

    const { assignments, refused } = routeMany(10, workers);

    // Each worker takes exactly one concurrent task; the remaining 7 wait rather
    // than oversubscribing anybody. Before M5.3 all 10 went to worker-a.
    expect(assignments.sort()).toEqual(["worker-a", "worker-b", "worker-c"]);
    expect(refused).toBe(7);
  });

  it("10 ready tasks across 3 workers of capacity 4 spread within one job of each other", () => {
    const workers = ["worker-a", "worker-b", "worker-c"].map((id) =>
      worker({ id, maxConcurrency: 4 }),
    );

    const { assignments, refused } = routeMany(10, workers);
    const counts = computeWorkerLoad(assignments, workers).byWorkerId;

    expect(refused).toBe(0);
    expect(Object.keys(counts).sort()).toEqual(["worker-a", "worker-b", "worker-c"]);
    const values = Object.values(counts);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it("AT_CAPACITY: a worker holding its declared maximum is refused, not merely deprioritised", () => {
    const solo = worker({ id: "worker-a", maxConcurrency: 1 });
    const verdict = evaluateWorkerEligibility(solo, {
      load: computeWorkerLoad(["worker-a"], [solo]),
      evidenceHorizon: HORIZON,
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("AT_CAPACITY");
    expect(selectWorker([solo], { load: computeWorkerLoad(["worker-a"], [solo]) })).toBeNull();
  });

  it("a worker with maxConcurrency 3 takes three jobs and then stops", () => {
    const big = worker({ id: "worker-a", maxConcurrency: 3 });
    const at = (n: number) =>
      evaluateWorkerEligibility(big, {
        load: computeWorkerLoad(Array.from({ length: n }, () => "worker-a"), [big]),
      }).eligible;

    expect([at(0), at(1), at(2), at(3)]).toEqual([true, true, true, false]);
  });

  it("CAPACITY_POOL_SATURATED: two workers sharing one quota cannot multiply it", () => {
    // Two DISTINCT workers, one shared provider/account capacity of 1.
    const a = worker({ id: "worker-a", capacityPool: "account-x", capacityPoolLimit: 1 });
    const b = worker({ id: "worker-b", capacityPool: "account-x", capacityPoolLimit: 1 });
    const workers = [a, b];

    // worker-a is busy. worker-b is completely idle, but the POOL is full.
    const load = computeWorkerLoad(["worker-a"], workers);

    expect(evaluateWorkerEligibility(b, { load }).reasons).toContain("CAPACITY_POOL_SATURATED");
    expect(selectWorker(workers, { load })).toBeNull();
  });

  it("a pool limit above current use still admits an idle member", () => {
    const a = worker({ id: "worker-a", capacityPool: "account-x", capacityPoolLimit: 2 });
    const b = worker({ id: "worker-b", capacityPool: "account-x", capacityPoolLimit: 2 });

    expect(selectWorker([a, b], { load: computeWorkerLoad(["worker-a"], [a, b]) })?.id).toBe(
      "worker-b",
    );
  });

  it("POOL_CEILING_RESOLVES_DOWNWARDS: one member declaring a bigger quota cannot raise it", () => {
    const strict = worker({ id: "worker-a", capacityPool: "account-x", capacityPoolLimit: 1 });
    const lax = worker({ id: "worker-b", capacityPool: "account-x", capacityPoolLimit: 99 });
    const workers = [strict, lax];

    expect(effectiveCapacityPoolLimits(workers)).toEqual({ "account-x": 1 });
    // One execution already charged to the pool: the strict ceiling governs both.
    expect(selectWorker(workers, { load: computeWorkerLoad(["worker-a"], workers) })).toBeNull();
  });

  it("workers in DIFFERENT pools do not constrain each other", () => {
    const a = worker({ id: "worker-a", capacityPool: "account-x", capacityPoolLimit: 1 });
    const b = worker({ id: "worker-b", capacityPool: "account-y", capacityPoolLimit: 1 });

    expect(selectWorker([a, b], { load: computeWorkerLoad(["worker-a"], [a, b]) })?.id).toBe(
      "worker-b",
    );
  });

  it("a worker with no pool is bounded by its own concurrency only", () => {
    const free = worker({ id: "worker-a", capacityPool: null, capacityPoolLimit: null });

    expect(evaluateWorkerEligibility(free, { load: computeWorkerLoad([], [free]) }).eligible).toBe(
      true,
    );
  });

  it("capacity NEVER rescues an ineligible worker: the gates are cumulative", () => {
    const unhealthy = worker({ id: "worker-a", health: "unhealthy" });

    expect(
      evaluateWorkerEligibility(unhealthy, { load: computeWorkerLoad([], [unhealthy]) }).eligible,
    ).toBe(false);
  });

  it("load is ignored for workers that are not eligible for other reasons", () => {
    const stale = worker({ id: "worker-a", lastProbeAt: "2026-01-01T00:00:00.000Z" });
    const busy = worker({ id: "worker-b" });

    // worker-a is idle (load 0) and would be preferred by the policy, but stale.
    const load = computeWorkerLoad(["worker-b"], [stale, busy]);
    expect(selectWorker([stale, busy], { load, evidenceHorizon: HORIZON })).toBeNull();
  });

  it("RESTART_SAFE: the policy has no hidden state — the same rows replay identically", () => {
    const workers = pool("worker-a", "worker-b", "worker-c");
    const assignments = ["worker-a", "worker-c"];

    const before = selectWorker(workers, {
      load: computeWorkerLoad(assignments, workers),
      evidenceHorizon: HORIZON,
    });
    // A "fresh process": rebuild every input from scratch, in a different order.
    const after = selectWorker([...workers].reverse(), {
      load: computeWorkerLoad([...assignments].reverse(), [...workers].reverse()),
      evidenceHorizon: HORIZON,
    });

    expect(after?.id).toBe("worker-b");
    expect(after?.id).toBe(before?.id);
  });

  it("computeWorkerLoad counts one entry per execution and charges pools correctly", () => {
    const a = worker({ id: "worker-a", capacityPool: "account-x", capacityPoolLimit: 4 });
    const b = worker({ id: "worker-b", capacityPool: "account-x", capacityPoolLimit: 4 });
    const c = worker({ id: "worker-c" });

    const load = computeWorkerLoad(["worker-a", "worker-a", "worker-b", "worker-c"], [a, b, c]);

    expect(load.byWorkerId).toEqual({ "worker-a": 2, "worker-b": 1, "worker-c": 1 });
    expect(load.byCapacityPool).toEqual({ "account-x": 3 });
  });

  it("WITHOUT a load snapshot the pre-M5.3 behaviour is preserved exactly", () => {
    const workers = pool("worker-b", "worker-a");

    // No load: ordering by id, no capacity gate. Reviewer selection and bounded
    // repair rely on this.
    expect(selectEligibleWorkers(workers, { evidenceHorizon: HORIZON }).map((w) => w.id)).toEqual([
      "worker-a",
      "worker-b",
    ]);
  });
});
