import { describe, expect, it } from "vitest";

import type { ImprovementCandidate } from "@/core/autonomy/improvement-backlog";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

import {
  candidatesByStatus,
  costMetric,
  memoryMetric,
  providerHealthMetric,
  selfDevelopmentMetric,
  tokenThroughputMetric,
} from "./truth-projection";
import { missing, real } from "./truth";

describe("cockpit truth projection (decision 0069)", () => {
  it("memory and self-development become real counts, and a miss stays a miss", () => {
    expect(memoryMetric(real({ records: 30, active: 28, retrievals24h: 54 }))).toMatchObject({
      kind: "real",
      value: 30,
    });
    const miss = missing<{ records: number; active: number; retrievals24h: number }>(
      "not_connected",
      "no db",
    );
    expect(memoryMetric(miss)).toBe(miss);
    const c = { status: "proposed" } as ImprovementCandidate;
    expect(
      selfDevelopmentMetric(real([c, c, { status: "implemented" } as ImprovementCandidate])),
    ).toMatchObject({ kind: "real", value: 3 });
    expect(
      candidatesByStatus([c, c, { status: "implemented" } as ImprovementCandidate]),
    ).toMatchObject({ proposed: 2, implemented: 1, approved: 0 });
  });

  it("cost is money only when every call is priced; otherwise it says UNPRICED, never 0.00", () => {
    expect(
      costMetric(
        real({ calls24h: 40, tokens24h: 9000, unpriced24h: 40, amount24h: null, currency: null }),
      ),
    ).toMatchObject({ kind: "real", value: "UNPRICED 40/40" });
    expect(
      costMetric(
        real({ calls24h: 4, tokens24h: 900, unpriced24h: 0, amount24h: 1.5, currency: "EUR" }),
      ),
    ).toMatchObject({ kind: "real", value: "1.50 EUR" });
    expect(
      tokenThroughputMetric(
        real({ calls24h: 4, tokens24h: 900, unpriced24h: 0, amount24h: null, currency: null }),
      ),
    ).toMatchObject({ kind: "real", value: 900 });
  });

  it("provider health is routable-over-registered from probe evidence, and nothing without workers", () => {
    const w = (health: string, availability: string) =>
      ({ health, availability }) as unknown as WorkerRegistryEntry;
    const metric = providerHealthMetric(
      real([w("healthy", "available"), w("healthy", "available"), w("unhealthy", "available")]),
    );
    expect(metric).toMatchObject({ kind: "real", value: 2 });
    expect(metric.kind === "real" && metric.derivation).toContain("3 registered");
    expect(providerHealthMetric(real([]))).toMatchObject({
      kind: "not_available",
      requirement: "BR-04",
    });
  });
});
