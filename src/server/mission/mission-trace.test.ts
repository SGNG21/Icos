import { describe, expect, it } from "vitest";
import { emptyWindow } from "@/core/budget/spend";
import { accumulate } from "@/core/budget/spend";
import { costLabel, formatMissionTrace, type MissionTrace } from "./mission-trace";

describe("mission trace cache reporting", () => {
  it("prints unknown, explicit zero and positive independently, including UNPRICED", () => {
    const trace: MissionTrace = {
      mission: { id: "m1", title: "fixture", status: "RUNNING", goalId: null },
      tasks: [],
      steps: [],
      sources: {},
      cost: {
        entries: [
          {
            id: "1",
            scope: "mission",
            attributionKey: "mission=m1",
            goalId: null,
            brainId: null,
            modelId: "test/model",
            usageKind: "METERED",
            promptTokens: 10,
            completionTokens: 0,
            totalTokens: 10,
            cacheRead: 0,
            cacheCreation: 5,
            costKind: "UNPRICED",
            currency: null,
            amount: null,
            reason: "unknown model",
            freeTier: null,
            observedAt: "2026-10-13T00:00:00.000Z",
          },
          {
            id: "2",
            scope: "mission",
            attributionKey: "mission=m1",
            goalId: null,
            brainId: null,
            modelId: "test/model",
            usageKind: "UNMETERED",
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cacheRead: null,
            cacheCreation: null,
            costKind: null,
            currency: null,
            amount: null,
            reason: "USAGE_ABSENT",
            freeTier: null,
            observedAt: "2026-10-13T00:00:00.000Z",
          },
        ],
        total: emptyWindow(),
        goalShared: emptyWindow(),
      },
    };
    const output = formatMissionTrace(trace);
    expect(output).toContain("cache read=0 creation=5");
    expect(output).toContain("cache read=unknown creation=unknown");
    expect(output).toContain(
      "cache coverage: read known on 1/2 calls, creation known on 1/2 calls",
    );
    expect(output).toContain("UNPRICED");
    expect(output).toContain("unmetered");
    if (!("entries" in trace.cost)) throw new Error("expected fixture entries");
    const partial = {
      ...trace,
      cost: {
        ...trace.cost,
        entries: [
          { ...trace.cost.entries[0], cacheCreation: null },
          trace.cost.entries[1],
          { ...trace.cost.entries[0], id: "shared", scope: "goal-shared" as const },
        ],
      },
    };
    expect(formatMissionTrace(partial)).toContain(
      "cache coverage: read known on 1/2 calls, creation known on 0/2 calls",
    );
  });
});

describe("mission trace — free tier, unknown cost and unknown model stay apart (ADR 0078)", () => {
  const row = {
    id: "1",
    scope: "mission" as const,
    attributionKey: "mission=m1",
    goalId: null,
    brainId: null,
    modelId: "test/free",
    usageKind: "METERED",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cacheRead: null,
    cacheCreation: null,
    costKind: "FREE_TIER",
    currency: "EUR",
    amount: 0,
    reason: null,
    freeTier: { source: "https://example.invalid/terms", verifiedOn: "2026-10-01" },
    observedAt: "2026-10-13T00:00:00.000Z",
  };

  it("prints a FREE_TIER row as 0 EUR (free tier, verified <date>)", () => {
    expect(costLabel(row)).toBe("0 EUR (free tier, verified 2026-10-01)");
  });

  it("prints an UNPRICED row as UNPRICED, never as 0 or free tier", () => {
    const label = costLabel({
      ...row,
      costKind: "UNPRICED",
      currency: null,
      amount: null,
      reason: "modèle absent du registre de prix",
      freeTier: null,
    });
    expect(label).toBe("UNPRICED");
  });

  it("prints a COST of 0 as a cost, not as a free tier", () => {
    expect(costLabel({ ...row, costKind: "COST", freeTier: null })).toBe("0 EUR");
  });

  it("never prints a FREE_TIER row without its proof as a plain zero", () => {
    expect(costLabel({ ...row, freeTier: null })).toBe("FREE_TIER (proof missing)");
  });

  it("the total line counts free-tier calls apart from unpriced ones", () => {
    const total = accumulate(emptyWindow(), {
      modelId: "test/free",
      usage: {
        kind: "METERED",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      cost: {
        kind: "FREE_TIER",
        currency: "EUR",
        amount: 0,
        modelId: "test/free",
        provenance: { source: "https://example.invalid/terms", verifiedOn: "2026-10-01" },
      },
    });
    const output = formatMissionTrace({
      mission: { id: "m1", title: "fixture", status: "RUNNING", goalId: null },
      tasks: [],
      steps: [],
      sources: {},
      cost: { entries: [row], total, goalShared: emptyWindow() },
    });
    expect(output).toContain("0 EUR (free tier, verified 2026-10-01)");
    expect(output).toContain("priced over 1 calls (1 free tier), 0 unpriced, 0 unmetered");
  });
});
