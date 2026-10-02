import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import { buildObjectiveReadModel } from "./objective-read-model";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const goal = (over: Partial<HighLevelGoal> = {}): HighLevelGoal => ({
  id: "g-1",
  title: "Occupe-toi de LDS",
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => ({
  goals: { list: vi.fn(async () => []) },
  missions: { findById: vi.fn(async () => null), listTasks: vi.fn(async () => []) },
  reviews: { listByMissionId: vi.fn(async () => []) },
  runtimes: { get: vi.fn(async () => null) },
  controlHolds: { isHeld: vi.fn(async () => false) },
  visibility: { unconvertedVisible: true, isMissionVisible: vi.fn(async () => true) },
  now: () => NOW,
  ...over,
});

describe("buildObjectiveReadModel", () => {
  it("reports a goal with no mission as RECEIVED with UNKNOWN progress", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          { goal: goal(), status: "pending", resultingMissionId: null, convertedAt: null },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.state).toBe("RECEIVED");
    expect(view.progress).toBe("UNKNOWN");
    expect(view.assignedWorkers).toBe("UNKNOWN");
  });

  it("reports cost as UNKNOWN, because no execution record carries one", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          { goal: goal(), status: "pending", resultingMissionId: null, convertedAt: null },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);
    expect(view.cost).toBe("UNKNOWN");
  });

  it("carries the priority decision with its policy version and missing evidence", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal({ metadata: { "icos.source": "cognitive_conversation" } }),
            status: "pending",
            resultingMissionId: null,
            convertedAt: null,
          },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.priority.class).toBe("USER");
    expect(view.priority.classSource).toBe("rule");
    expect(view.priority.policyVersion).toMatch(/^priority\//);
    expect(view.priority.missing.length).toBeGreaterThan(0);
  });

  it("degrades when a converted goal names a mission that cannot be read", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-gone",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      missions: { findById: vi.fn(async () => null), listTasks: vi.fn(async () => []) },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.state).toBe("DEGRADED");
    expect(view.degraded?.unknown).toContain("mission");
    expect(view.blockedReason).toBe("mission_unreadable");
  });

  it("counts progress and names the workers a running mission has assigned", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-1",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      runtimes: { get: vi.fn(async () => ({ state: "running" })) },
      missions: {
        findById: vi.fn(async () => ({ id: "m-1", status: "running" })),
        listTasks: vi.fn(async () => [
          { taskId: "t1", status: "succeeded", workerKind: "engineering" },
          { taskId: "t2", status: "running", workerKind: "seo" },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.state).toBe("EXECUTING");
    expect(view.progress).toEqual({ tasksTotal: 2, tasksSettled: 1 });
    expect(view.assignedWorkers).toEqual(["engineering", "seo"]);
  });

  it("surfaces the latest review verdict and flags a human decision", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-1",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      runtimes: { get: vi.fn(async () => ({ state: "running" })) },
      missions: {
        findById: vi.fn(async () => ({ id: "m-1", status: "running" })),
        listTasks: vi.fn(async () => [
          { taskId: "t1", status: "awaiting_approval", workerKind: null },
        ]),
      },
      reviews: {
        listByMissionId: vi.fn(async () => [
          {
            taskId: "t1",
            decision: "REQUEST_CHANGES",
            reasons: ["scope"],
            createdAt: "2026-10-02T11:00:00.000Z",
          },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.reviewState).toBe("REQUEST_CHANGES");
    expect(view.humanDecisionRequired).toBe(true);
    expect(view.state).toBe("WAITING_FOR_HUMAN");
    expect(view.latestMeaningfulResult).toContain("REQUEST_CHANGES");
  });

  it("SUPERVISOR_STALE_MEMORY_NOT_LIVE_AUTHORITY: an old review never overrides live rows", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-1",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      missions: {
        findById: vi.fn(async () => ({ id: "m-1", status: "succeeded" })),
        listTasks: vi.fn(async () => [{ taskId: "t1", status: "succeeded", workerKind: "eng" }]),
      },
      reviews: {
        listByMissionId: vi.fn(async () => [
          {
            taskId: "t1",
            decision: "BLOCK",
            reasons: ["an older verdict"],
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    // The live mission row says succeeded. A stale BLOCK is reported, never obeyed.
    expect(view.state).toBe("COMPLETED");
    expect(view.reviewState).toBe("BLOCK");
  });

  it("orders objectives by the priority governor's total order", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal({ id: "research" }),
            status: "pending",
            resultingMissionId: null,
            convertedAt: null,
          },
          {
            goal: goal({ id: "user", metadata: { "icos.source": "cognitive_conversation" } }),
            status: "pending",
            resultingMissionId: null,
            convertedAt: null,
          },
        ]),
      },
    });
    const views = await buildObjectiveReadModel(d as never);
    expect(views.map((v) => v.objectiveId)).toEqual(["user", "research"]);
  });
});

describe("buildObjectiveReadModel — visibility and bounds (review C1, C2, I1)", () => {
  const records = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      goal: goal({ id: `g-${i}` }),
      status: "converted",
      resultingMissionId: `m-${i}`,
      convertedAt: NOW.toISOString(),
    }));

  it("C1: hides an objective whose mission the reader may not see", async () => {
    const d = deps({
      goals: { list: vi.fn(async () => records(2)) },
      missions: {
        findById: vi.fn(async (id: string) => ({ id, status: "ready" })),
        listTasks: vi.fn(async () => [{ taskId: "t", status: "queued", workerKind: null }]),
      },
      visibility: {
        unconvertedVisible: false,
        isMissionVisible: vi.fn(async (missionId: string) => missionId === "m-0"),
      },
    });
    const views = await buildObjectiveReadModel(d as never);
    expect(views.map((v) => v.objectiveId)).toEqual(["g-0"]);
  });

  it("C1: hides un-launched goals from a reader without global scope", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          { goal: goal({ id: "g-pending" }), status: "pending", resultingMissionId: null, convertedAt: null },
        ]),
      },
      visibility: { unconvertedVisible: false, isMissionVisible: vi.fn(async () => true) },
    });
    expect(await buildObjectiveReadModel(d as never)).toEqual([]);
  });

  it("C1: a visibility check that throws hides the objective, it does not reveal it", async () => {
    const d = deps({
      goals: { list: vi.fn(async () => records(1)) },
      missions: {
        findById: vi.fn(async (id: string) => ({ id, status: "ready" })),
        listTasks: vi.fn(async () => []),
      },
      visibility: {
        unconvertedVisible: false,
        isMissionVisible: vi.fn(async () => {
          throw new Error("scope service down");
        }),
      },
    });
    expect(await buildObjectiveReadModel(d as never)).toEqual([]);
  });

  it("C2: applies a default row limit instead of loading every goal ever created", async () => {
    const list = vi.fn(async (_filter?: { status?: string; limit?: number }) => records(5));
    await buildObjectiveReadModel(deps({ goals: { list } }) as never);
    const passed = list.mock.calls[0]?.[0];
    expect(passed?.limit).toBeGreaterThan(0);
    expect(passed?.limit).toBeLessThanOrEqual(200);
  });

  it("C2: never has more than a bounded number of objectives in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const findById = vi.fn(async (id: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { id, status: "ready" };
    });
    const d = deps({
      goals: { list: vi.fn(async () => records(40)) },
      missions: { findById, listTasks: vi.fn(async () => []) },
    });
    await buildObjectiveReadModel(d as never, { limit: 40 });
    expect(peak).toBeLessThanOrEqual(10);
  });

  it("I1: an unreadable control hold degrades, it never renders as 'not held'", async () => {
    const d = deps({
      goals: { list: vi.fn(async () => records(1)) },
      missions: {
        findById: vi.fn(async (id: string) => ({ id, status: "ready" })),
        listTasks: vi.fn(async () => [{ taskId: "t", status: "queued", workerKind: null }]),
      },
      controlHolds: {
        isHeld: vi.fn(async () => {
          throw new Error("control store unreachable");
        }),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);
    expect(view.state).toBe("DEGRADED");
    expect(view.degraded?.unknown).toContain("controlHold");
  });
});
