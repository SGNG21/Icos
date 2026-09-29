import { describe, expect, it } from "vitest";

import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";

import { UNDECLARED_FAMILY, buildCompute, routingEvidenceOf } from "./compute";
import type { WorkerView } from "./snapshot";
import { missing, real } from "./truth";

const worker = (id: string, metadata: Record<string, string>): WorkerView => ({
  id,
  name: `compute:${metadata.model ?? id}`,
  kind: "agent",
  runtime: "hermes",
  runtimeSupport: "SUPPORTED_RUNTIME",
  status: "active",
  health: "healthy",
  availability: "available",
  probe: { outcome: "ok", at: "2026-09-29T11:59:00Z", ageMs: 60_000 },
  model: metadata.model ? real(metadata.model) : missing("not_available", "none", "BR-03"),
  provider: metadata.provider ? real(metadata.provider) : missing("not_available", "none", "BR-03"),
  account: missing("not_available", "none", "BR-03"),
  slots: { used: real(1), max: 2 },
  pool: metadata.provider ? { name: `provider:${metadata.provider}`, limit: 4 } : null,
  capabilities: [],
  features: [],
  tags: [],
  metadata,
  assignments: [],
  leases: real([]),
  tone: "ok",
  routable: true,
});

const W120 = "11111111-1111-4111-8111-111111111111";
const W550 = "55555555-5555-4555-8555-555555555555";
const evidence = {
  kind: "ROUTING_DECISION",
  policyVersion: "compute-routing/1",
  decidedAt: "2026-09-29T11:00:00Z",
  role: "writer",
  requirement: { complexity: "high" },
  requiredTier: 4,
  escalationReason: ["2nd legitimate rejection"],
  candidateSet: [
    { workerId: W120, selectable: false, excludedBecause: ["BELOW_REQUIRED_TIER"], history: { executions: 10, infraFailures: 2, timeouts: 1, reviewed: 8 } },
    { workerId: W550, selectable: true, fallback: "TIER_FALLBACK", excludedBecause: [], history: { executions: 0, infraFailures: 0, timeouts: 0, reviewed: 0 } },
  ],
  selected: { workerId: W550, score: 0.71, modelSteered: true },
  futureField: "tolerated",
};
const attempt = (routingDecision?: unknown) =>
  ({ id: "a1", missionId: "m", missionTaskId: "mt", taskId: "t", attempt: 1, state: "dispatched", routingDecision }) as unknown as DispatchAttempt;

const fleet = [
  worker(W120, { model: "nvidia/nemotron-3-super-120b-a12b", provider: "nvidia", modelFamily: "NEMOTRON_120B" }),
  worker(W550, { model: "nvidia/nemotron-3-ultra-550b-a55b", provider: "nvidia", modelFamily: "NEMOTRON_550B" }),
  worker("legacy", {}),
];

describe("compute view", () => {
  it("groups by declared family as an open set; unknown families are not dropped", () => {
    const groups = buildCompute(
      [...fleet, worker("f", { model: "acme/next-gen-9", modelFamily: "ACME_NEXT" })],
      real([]),
    );
    expect(groups.map((g) => g.family)).toEqual(["ACME_NEXT", "NEMOTRON_120B", "NEMOTRON_550B", UNDECLARED_FAMILY]);
    expect(groups.at(-1)!.rows[0].family.kind).toBe("unknown");
  });

  it("without routing evidence, router facts are NOT_CONNECTED — never zero", () => {
    const row = buildCompute(fleet, real([attempt()]))[0].rows[0];
    for (const k of ["timeoutRate", "infraFailureRate", "routingExclusions", "rateLimit", "modelSteered", "fallbackEvents", "routingReason"] as const)
      expect(row[k].kind, k).toBe("not_connected");
    expect(row.latency.kind).toBe("not_available");
    expect(row.credentialHealth.kind).toBe("not_available");
  });

  it("reads persisted ROUTING_DECISION evidence without recomputing it", () => {
    expect(routingEvidenceOf([attempt(evidence), attempt({ kind: "OTHER" })])).toHaveLength(1);
    const [g120, g550] = buildCompute(fleet, real([attempt(evidence)]));
    const r120 = g120.rows[0];
    expect(r120.timeoutRate).toMatchObject({ kind: "real", value: 0.1 });
    expect(r120.infraFailureRate).toMatchObject({ kind: "real", value: 0.2 });
    expect(r120.routingExclusions).toMatchObject({ kind: "real", value: ["BELOW_REQUIRED_TIER"] });
    expect(r120.routingReason.kind).toBe("not_connected"); // never selected
    const r550 = g550.rows[0];
    expect(r550.fallbackEvents).toMatchObject({ kind: "real", value: 1 });
    expect(r550.modelSteered).toMatchObject({ kind: "real", value: true });
    expect(r550.timeoutRate.kind).toBe("unknown"); // cold start: no history is not a 0% rate
    expect(r550.routingReason).toMatchObject({ kind: "real" });
    expect((r550.routingReason as { value: string }).value).toContain("tier ≥ 4");
  });

  it("route is the provider quota (capacity pool)", () => {
    const row = buildCompute(fleet, real([]))[1].rows[0];
    expect(row.route).toMatchObject({ kind: "real", value: "provider:nvidia" });
  });
});
