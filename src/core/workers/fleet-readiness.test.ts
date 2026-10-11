import { describe, expect, it } from "vitest";

import {
  workerRegistryEntrySchema,
  type WorkerRegistryEntry,
} from "@/core/contracts/worker-registry";

import {
  FLEET_PROVIDER_UNDECLARED,
  measureFleet,
  PROBE_ERROR_CLASSES,
  type ProviderReadiness,
} from "./fleet-readiness";
import { HEALTH_EVIDENCE_MAX_AGE_MS, selectEligibleWorkers } from "./worker-eligibility";

const NOW = "2026-10-11T12:00:00.000Z";
const FRESH = "2026-10-11T11:59:30.000Z"; // 30 s old
const OLD = "2026-10-11T11:50:00.000Z"; // 10 min old

let seq = 0;
function worker(
  overrides: Partial<WorkerRegistryEntry> & { provider?: string },
): WorkerRegistryEntry {
  seq += 1;
  const { provider, ...rest } = overrides;
  return workerRegistryEntrySchema.parse({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    workerKind: "agent",
    displayName: `w${seq}`,
    runtime: "binary",
    runtimeSupport: "SUPPORTED_RUNTIME",
    status: "active",
    health: "healthy",
    availability: "available",
    lastProbeAt: FRESH,
    lastProbeOutcome: "ok",
    metadata: provider === undefined ? {} : { provider },
    updatedAt: FRESH,
    ...rest,
  });
}

function slice(rows: WorkerRegistryEntry[], provider: string): ProviderReadiness {
  return measureFleet(rows, NOW).providers.find((p) => p.provider === provider)!;
}

/** The exclusive-bucket invariant every slice must satisfy. */
function assertPartition(p: ProviderReadiness) {
  const failing = PROBE_ERROR_CLASSES.reduce((n, c) => n + p.failing[c], 0);
  expect(p.routable + p.unsupported + p.unprobed + p.stale + failing + p.degraded).toBe(p.active);
  expect(p.notConfigured).toBe(p.failing.NOT_CONFIGURED);
}

describe("measureFleet", () => {
  it("HEALTHY_FLEET: every freshly probed active worker is routable, per provider", () => {
    const rows = [
      worker({ provider: "claude" }),
      worker({ provider: "claude" }),
      worker({ provider: "nvidia" }),
    ];

    const m = measureFleet(rows, NOW);

    expect(m.providers.map((p) => p.provider)).toEqual(["claude", "nvidia"]);
    expect(slice(rows, "claude")).toMatchObject({ active: 2, routable: 2, disabled: 0 });
    expect(m.total).toMatchObject({ provider: "*", active: 3, routable: 3 });
    expect(m.maxEvidenceAgeMs).toBe(HEALTH_EVIDENCE_MAX_AGE_MS);
    expect(m.measuredAt).toBe(NOW);
    for (const p of [...m.providers, m.total]) assertPartition(p);
  });

  it("CREDENTIAL_LESS_PROVIDER: failures are counted by class, NOT_CONFIGURED by name", () => {
    const failed = {
      health: "unhealthy",
      availability: "unavailable",
      lastProbeOutcome: "failed",
    } as const;
    const rows = [
      worker({ provider: "nvidia", ...failed, lastProbeErrorClass: "NOT_CONFIGURED" }),
      worker({ provider: "nvidia", ...failed, lastProbeErrorClass: "NOT_CONFIGURED" }),
      worker({ provider: "nvidia", ...failed, lastProbeErrorClass: "RATE_LIMITED" }),
      /* A failure persisted before migration 0062 has no class: UNKNOWN, never dropped. */
      worker({ provider: "nvidia", ...failed }),
    ];

    const p = slice(rows, "nvidia");

    expect(p).toMatchObject({ active: 4, routable: 0, notConfigured: 2 });
    expect(p.failing).toEqual({
      NOT_CONFIGURED: 2,
      AUTH_FAILURE: 0,
      RATE_LIMITED: 1,
      UNAVAILABLE: 0,
      UNKNOWN: 1,
    });
    assertPartition(p);
  });

  it("DISABLED_WHILE_HEALTHY: a disabled row is never routable, even with a stored 'healthy'", () => {
    /* A row written before deactivate() cleared health: the old self-model counted it. */
    const rows = [
      worker({ provider: "claude", status: "inactive" }),
      worker({ provider: "claude" }),
    ];

    const p = slice(rows, "claude");

    expect(p).toMatchObject({ active: 1, routable: 1, disabled: 1 });
    assertPartition(p);
  });

  it("STALE_EVIDENCE: 'healthy' older than the router's horizon is stale, not routable", () => {
    const rows = [
      worker({ provider: "codex", lastProbeAt: OLD }),
      worker({
        provider: "codex",
        health: "unknown",
        availability: "unknown",
        lastProbeOutcome: "stale",
        lastProbeAt: OLD,
      }),
    ];

    const p = slice(rows, "codex");

    expect(p).toMatchObject({ active: 2, routable: 0, stale: 2 });
    assertPartition(p);
  });

  it("ORPHAN_RETIRED: a retired orphan is disabled capacity, outside the active partition", () => {
    const rows = [
      worker({
        provider: "codex",
        status: "inactive",
        health: "unknown",
        availability: "unknown",
        lastProbeOutcome: "stale",
        lastProbeErrorClass: "UNAVAILABLE",
        metadata: { provider: "codex", fleetRetirement: "ORPHAN_NOT_LISTED" },
      }),
    ];

    const p = slice(rows, "codex");

    expect(p).toMatchObject({ active: 0, routable: 0, disabled: 1, stale: 0 });
    expect(p.failing.UNAVAILABLE).toBe(0);
  });

  it("unprobed, unsupported, degraded and undeclared providers each land in exactly one bucket", () => {
    const rows = [
      worker({
        health: "unknown",
        availability: "unknown",
        lastProbeAt: null,
        lastProbeOutcome: "never",
      }),
      worker({ runtimeSupport: "DECLARED_ONLY" }),
      worker({ health: "unknown", availability: "unknown", lastProbeOutcome: "unsupported" }),
      worker({ health: "degraded" }),
    ];

    const p = slice(rows, FLEET_PROVIDER_UNDECLARED);

    expect(p).toMatchObject({ active: 4, routable: 0, unprobed: 1, unsupported: 2, degraded: 1 });
    assertPartition(p);
  });

  it("ROUTABLE_IS_THE_ROUTER'S_ANSWER: the count equals the canonical matcher's selection", () => {
    const rows = [
      worker({ provider: "a" }),
      worker({ provider: "a", lastProbeAt: OLD }),
      worker({ provider: "b", status: "inactive" }),
      worker({ provider: "b", runtimeSupport: "UNKNOWN" }),
      worker({
        provider: "b",
        health: "unhealthy",
        availability: "unavailable",
        lastProbeOutcome: "failed",
      }),
    ];

    const routed = selectEligibleWorkers(rows, {
      evidenceHorizon: { now: NOW, maxAgeMs: HEALTH_EVIDENCE_MAX_AGE_MS },
    });

    expect(measureFleet(rows, NOW).total.routable).toBe(routed.length);
  });

  it("is pure: the same rows and clock measure the same fleet", () => {
    const rows = [worker({ provider: "a" }), worker({ provider: "b", lastProbeAt: OLD })];
    expect(measureFleet(rows, new Date(NOW))).toEqual(measureFleet([...rows].reverse(), NOW));
  });
});
