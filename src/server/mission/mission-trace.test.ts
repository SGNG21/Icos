import { describe, expect, it } from "vitest";
import { emptyWindow } from "@/core/budget/spend";
import { formatMissionTrace, type MissionTrace } from "./mission-trace";

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
