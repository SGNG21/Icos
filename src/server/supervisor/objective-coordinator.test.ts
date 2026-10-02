import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { DEFAULT_PORTFOLIO_POLICY } from "@/core/supervisor/portfolio";

import { ObjectiveCoordinator } from "./objective-coordinator";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const goal = (over: Partial<HighLevelGoal> = {}): HighLevelGoal => ({
  id: "g-1",
  title: "Improve the Mécène",
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

const deps = (over: Record<string, unknown> = {}) => {
  const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
    job: { id: "job-1", missionId: "m-1", ...input },
    created: true,
  }));
  return {
    enqueue,
    deps: {
      scheduler: { enqueue } as never,
      goals: { list: vi.fn(async () => []) } as never,
      missions: { list: vi.fn(async () => []) } as never,
      now: () => NOW,
      ...over,
    },
  };
};

describe("ObjectiveCoordinator", () => {
  it("enqueues the existing start_mission job with a scored priority", async () => {
    const { enqueue, deps: d } = deps();
    const c = new ObjectiveCoordinator(d);

    const r = await c.admit({
      goal: goal({ metadata: { "icos.source": "cognitive_conversation" } }),
      idempotencyKey: "k-1",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("enqueued");
    const call = enqueue.mock.calls[0][0];
    expect(call.kind).toBe("start_mission");
    expect(call.idempotencyKey).toBe("k-1");
    expect(call.priority).toBeGreaterThan(80);
    expect(call.runAt).toBeUndefined();
  });

  it("uses only the existing job kind — it never invents a second one", async () => {
    const { enqueue, deps: d } = deps();
    await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(enqueue.mock.calls.every(([c]) => c.kind === "start_mission")).toBe(true);
  });

  it("defers by setting runAt on the same job, never by rejecting", async () => {
    // Saturate RESEARCH, which the default policy caps at 1 concurrent objective.
    const active = Array.from({ length: DEFAULT_PORTFOLIO_POLICY.classes.RESEARCH.maxConcurrent });
    const { enqueue, deps: d } = deps({
      goals: {
        list: vi.fn(async () =>
          active.map((_, i) => ({
            goal: goal({ id: `running-${i}` }),
            status: "converted",
            resultingMissionId: `m-${i}`,
            convertedAt: NOW.toISOString(),
          })),
        ),
      },
      missions: {
        list: vi.fn(async () => active.map((_, i) => ({ id: `m-${i}`, status: "running" }))),
      },
    });

    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-new" }),
      idempotencyKey: "k-2",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("deferred");
    if (r.outcome !== "deferred") throw new Error("unreachable");
    expect(r.reason).toBe("CLASS_CONCURRENCY");
    const call = enqueue.mock.calls[0][0];
    expect(call.kind).toBe("start_mission");
    expect((call.runAt as Date).getTime()).toBe(NOW.getTime() + r.retryAfterMs);
  });

  it("carries the priority and allocation evidence on the result", async () => {
    const { deps: d } = deps();
    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k-3",
      title: "t",
      objective: "o",
    });
    expect(r.evidence.priority.policyVersion).toMatch(/^priority\//);
    expect(r.evidence.allocation.policyVersion).toMatch(/^portfolio\//);
    expect(r.evidence.priority.missing.length).toBeGreaterThan(0);
  });

  it("holds no state between calls", async () => {
    const { deps: d } = deps();
    const c = new ObjectiveCoordinator(d);
    const a = await c.admit({ goal: goal(), idempotencyKey: "k", title: "t", objective: "o" });
    const b = await c.admit({ goal: goal(), idempotencyKey: "k", title: "t", objective: "o" });
    expect(a.evidence).toEqual(b.evidence);
  });

  it("passes the caller's goalId through unchanged", async () => {
    const { enqueue, deps: d } = deps();
    await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-abc" }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(enqueue.mock.calls[0][0].payload).toEqual({
      title: "t",
      objective: "o",
      goalId: "g-abc",
    });
  });
});

describe("ObjectiveCoordinator — the cap must actually cap (review I3, I6)", () => {
  const pendingJobsOf = (classes: string[]) =>
    classes.map((c, i) => ({
      id: `job-${i}`,
      kind: "start_mission" as const,
      payload: { goalId: `pending-${i}`, workClass: c },
    }));

  it("I3: counts enqueued-but-not-yet-run launches, not only live missions", async () => {
    /*
     * A start_mission job that has not run yet has no mission row and its goal is still
     * `pending`: counting only live missions let 20 approvals in one minute all admit.
     */
    const { enqueue, deps: d } = deps({
      pendingLaunches: {
        countByWorkClass: vi.fn(async () => ({ RESEARCH: 1 })),
      },
    });

    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-new" }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("deferred");
    if (r.outcome !== "deferred") throw new Error("unreachable");
    expect(r.reason).toBe("CLASS_CONCURRENCY");
    expect(r.evidence.allocation.activeInClass).toBe(1);
    expect(enqueue.mock.calls[0][0].runAt).toBeDefined();
  });

  it("I3: a pending launch the coordinator cannot count degrades to refusing, not to admitting", async () => {
    const { deps: d } = deps({
      pendingLaunches: {
        countByWorkClass: vi.fn(async () => {
          throw new Error("scheduler unreadable");
        }),
      },
    });
    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g" }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(r.outcome).toBe("deferred");
  });

  it("I6: asks the mission store only for the statuses that occupy a slot", async () => {
    const list = vi.fn(async (_f?: { status?: string }) => []);
    const { deps: d } = deps({ missions: { list } });
    await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    // Every call must be filtered: an unfiltered list is a full table scan on a write path.
    expect(list.mock.calls.length).toBeGreaterThan(0);
    for (const [filter] of list.mock.calls) expect(filter?.status).toBeDefined();
  });
});
