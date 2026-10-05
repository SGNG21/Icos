import { describe, expect, it, vi } from "vitest";

import { settleMission } from "@/core/mission/settlement";
import {
  AutonomousMissionRunner,
  type AutonomousSupervisor,
} from "@/server/autonomy/autonomous-mission-runner";
import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

/**
 * THE LIVE DEFECT.
 *
 * Five missions sat at `draft` with every task long since succeeded or failed — one of
 * them for sixteen days — each still holding the workforce assignments a terminal mission
 * gives back, until Chief had no capacity left to delegate anything new.
 *
 * Settlement existed, at the very end of `SupervisorService.run()`. What made it
 * unreachable was ORDER: the autonomous runner checks its wall-clock budget at the top of
 * its loop, measured from a `startedAt` that is never reset, so once an hour had elapsed
 * every later wake-up returned at that guard and the supervisor never ran again. The
 * recovery sweep woke them once a minute and the guard sent it away again, which also
 * kept `autonomous_mission_runtime.updated_at` looking fresh the whole time — so runtime
 * freshness could never have served as the reconciliation trigger either.
 */
describe("a mission settles on what its work has done, not on time remaining", () => {
  const BLOWN_BUDGET: AutonomousMissionRuntime = {
    missionId: "m1",
    state: "escalated",
    /* Exactly the live shape: a 1h budget opened 16 days ago. */
    startedAt: new Date("2026-09-18T23:28:53Z"),
    updatedAt: new Date("2026-10-05T08:30:00Z"),
    lastHeartbeatAt: new Date("2026-10-05T08:30:00Z"),
    lastProgressAt: new Date("2026-09-18T23:30:00Z"),
    cycleCount: 1,
    replanCount: 0,
    stagnationCount: 0,
    maxCycles: 50,
    maxReplans: 3,
    maxRuntimeMs: 3_600_000,
    maxStagnationCycles: 3,
    lastReason: "AUTONOMY_RUNTIME_BUDGET_EXCEEDED",
    ownerToken: null,
    leaseUntil: null,
  };

  function runtimeRepository(runtime: AutonomousMissionRuntime) {
    let current = { ...runtime };
    return {
      saved: () => current,
      repository: {
        create: vi.fn(async () => undefined),
        createIfAbsent: vi.fn(async () => false),
        get: vi.fn(async () => current),
        listRecoverable: vi.fn(async () => []),
        save: vi.fn(async (next: AutonomousMissionRuntime) => {
          current = next;
        }),
        saveOwned: vi.fn(async (next: AutonomousMissionRuntime) => {
          current = next;
        }),
        claim: vi.fn(async () => true),
        renewClaim: vi.fn(async () => true),
        release: vi.fn(async () => undefined),
      } as unknown as AutonomousMissionRuntimeRepository,
    };
  }

  const missions = {
    findById: vi.fn(async () => ({ id: "m1", status: "draft", goalId: null }) as never),
    listTasks: vi.fn(async () => [] as never[]),
    applyPlan: vi.fn(async () => undefined),
    replacePlan: vi.fn(async () => undefined),
  };

  const planner = { plan: vi.fn(async () => ({ tasks: [] }) as never) };

  it("finishes a mission whose work is over although its runtime budget is long gone", async () => {
    const store = runtimeRepository(BLOWN_BUDGET);
    const supervisor: AutonomousSupervisor = {
      run: vi.fn(async () => undefined),
      reconcilePreparedDispatches: vi.fn(async () => undefined),
      settleIfComplete: vi.fn(async () => ({
        settled: true as const,
        status: "succeeded" as const,
        reason: "ALL_TASKS_SUCCEEDED",
      })),
    };

    const result = await new AutonomousMissionRunner(
      missions as never,
      supervisor,
      planner as never,
      { maxCycles: 50, maxRuntimeMs: 3_600_000, maxStagnationCycles: 3, maxReplans: 3 },
      () => new Date("2026-10-05T08:30:00Z"),
      store.repository,
    ).run("m1");

    /* Before the fix this returned escalated / AUTONOMY_RUNTIME_BUDGET_EXCEEDED, for ever. */
    expect(result.state).toBe("succeeded");
    expect(result.reason).toContain("MISSION_SETTLED");
    expect(supervisor.settleIfComplete).toHaveBeenCalledWith("m1");
    expect(store.saved().state).toBe("succeeded");
  });

  it("still refuses to start new work once the budget is gone", async () => {
    const store = runtimeRepository(BLOWN_BUDGET);
    const supervisor: AutonomousSupervisor = {
      run: vi.fn(async () => undefined),
      reconcilePreparedDispatches: vi.fn(async () => undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TASK_NOT_TERMINAL" })),
    };

    const result = await new AutonomousMissionRunner(
      missions as never,
      supervisor,
      planner as never,
      { maxCycles: 50, maxRuntimeMs: 3_600_000, maxStagnationCycles: 3, maxReplans: 3 },
      () => new Date("2026-10-05T08:30:00Z"),
      store.repository,
    ).run("m1");

    /* Budgets still bound NEW work; they only stopped bounding FINISHING. */
    expect(result.state).toBe("escalated");
    expect(result.reason).toBe("AUTONOMY_RUNTIME_BUDGET_EXCEEDED");
    expect(supervisor.run).not.toHaveBeenCalled();
  });
});

describe("the settlement predicate", () => {
  const base = { missionStatus: "draft", activeAttempts: 0, dispatchPassCompleted: true };
  /* What the runner asks before spending budget: no dispatch pass has run this cycle. */
  const beforeDispatch = { ...base, dispatchPassCompleted: false };

  it("settles a mission whose tasks all succeeded", () => {
    expect(settleMission({ ...base, taskStatuses: ["succeeded", "succeeded"] })).toEqual({
      settled: true,
      status: "succeeded",
      reason: "ALL_TASKS_SUCCEEDED",
    });
  });

  it("lets the worst outcome win, so a partial success hides no failure", () => {
    /* The exact live row: one task failed, one succeeded, mission stuck at draft. */
    expect(settleMission({ ...base, taskStatuses: ["failed", "succeeded"] })).toMatchObject({
      settled: true,
      status: "failed",
    });
    expect(settleMission({ ...base, taskStatuses: ["blocked", "succeeded"] })).toMatchObject({
      settled: true,
      status: "blocked",
    });
  });

  it("a failure settles the mission although dependent work never ran", () => {
    /*
     * Task B failed, so C was never dispatched and stays draft for ever. Waiting for the
     * whole graph to be terminal would strand exactly the mission this fixes.
     */
    expect(settleMission({ ...base, taskStatuses: ["succeeded", "failed", "draft"] })).toMatchObject(
      { settled: true, status: "failed" },
    );
  });

  it("but not before a dispatch pass has had its say", () => {
    /*
     * The runner asks this ahead of its budget. A task blocked by transient capacity must
     * not end a mission whose other branches are about to be dispatched.
     */
    expect(
      settleMission({ ...beforeDispatch, taskStatuses: ["blocked", "draft"] }),
    ).toMatchObject({ settled: false, reason: "TASK_NOT_TERMINAL:draft" });

    /* Once everything IS terminal, the same caller settles on the worst outcome. */
    expect(
      settleMission({ ...beforeDispatch, taskStatuses: ["blocked", "succeeded"] }),
    ).toMatchObject({ settled: true, status: "blocked" });
  });

  it("ignores a leftover attempt on work that is already finished", () => {
    /*
     * A live mission sat at draft for a day behind one pre-invariant `dispatched` row with
     * no lease, which nothing can reclaim. The task was succeeded: that status, not the
     * ledger row, is what refuses a late result.
     */
    expect(settleMission({ ...base, taskStatuses: ["succeeded"], activeAttempts: 0 })).toMatchObject(
      { settled: true, status: "succeeded" },
    );
  });

  it("counts a superseded task as finished, because a replan replaced it", () => {
    expect(settleMission({ ...base, taskStatuses: ["superseded", "succeeded"] })).toMatchObject({
      settled: true,
      status: "succeeded",
    });
  });

  describe("fails closed", () => {
    it("waits for work that is still running", () => {
      for (const pending of ["draft", "queued", "running"]) {
        expect(settleMission({ ...base, taskStatuses: ["succeeded", pending] })).toMatchObject({
          settled: false,
        });
      }
    });

    it("waits for a review and for an approval", () => {
      /* Review satisfaction and pending approval are task statuses, so one rule covers both. */
      expect(settleMission({ ...base, taskStatuses: ["review_pending"] })).toMatchObject({
        settled: false,
        reason: "TASK_NOT_TERMINAL:review_pending",
      });
      expect(settleMission({ ...base, taskStatuses: ["awaiting_approval"] })).toMatchObject({
        settled: false,
      });
    });

    it("waits for a live dispatch attempt even when every task reads terminal", () => {
      /*
       * The case the old guard could not see: it called `listByMissionId?.()`, which this
       * repository has never had, so optional chaining answered undefined and the check
       * passed without asking anything.
       */
      expect(
        settleMission({ ...base, taskStatuses: ["failed", "running"], activeAttempts: 1 }),
      ).toMatchObject({ settled: false, reason: "ATTEMPT_ACTIVE:1" });

      /* Same graph, ledger quiet: the failure is decisive. */
      expect(
        settleMission({ ...base, taskStatuses: ["failed", "running"], activeAttempts: 0 }),
      ).toMatchObject({ settled: true, status: "failed" });
    });

    it("does not call an unplanned mission successful", () => {
      expect(settleMission({ ...base, taskStatuses: [] })).toMatchObject({
        settled: false,
        reason: "MISSION_HAS_NO_PLAN",
      });
    });

    it("does not settle a mission mid-replan", () => {
      expect(settleMission({ ...base, taskStatuses: ["superseded", "superseded"] })).toMatchObject({
        settled: false,
        reason: "ALL_WORK_SUPERSEDED",
      });
    });

    it("refuses an attempt count that is not a real count", () => {
      expect(() =>
        settleMission({ ...base, taskStatuses: ["succeeded"], activeAttempts: NaN }),
      ).toThrow("MISSION_SETTLEMENT_INVALID_ATTEMPT_COUNT");
      expect(() =>
        settleMission({ ...base, taskStatuses: ["succeeded"], activeAttempts: undefined as never }),
      ).toThrow("MISSION_SETTLEMENT_INVALID_ATTEMPT_COUNT");
    });
  });

  it("is idempotent: an already terminal mission is left exactly as it is", () => {
    for (const status of ["succeeded", "failed", "blocked", "cancelled"]) {
      expect(settleMission({ ...base, missionStatus: status, taskStatuses: ["failed"] }))
        .toMatchObject({ settled: false, reason: `MISSION_ALREADY_TERMINAL:${status}` });
    }
  });
});

/**
 * Settlement is the one place capacity comes back, so it has to be safe to call twice —
 * the recovery sweep and the runner both call it, and a second release would hand back
 * assignments a LATER mission now holds.
 */
describe("settleIfComplete releases capacity exactly once", () => {
  function service(statuses: string[], activeAttempts: number) {
    let missionStatus = "draft";
    const releaseDelegation = vi.fn(async () => undefined);
    const updateMissionStatus = vi.fn(async (_id: string, status: string) => {
      missionStatus = status;
    });
    const missionRepository = {
      findById: vi.fn(async () => ({ id: "m1", status: missionStatus })),
      listTasks: vi.fn(async () => statuses.map((status, i) => ({ id: `t${i}`, status }))),
      updateMissionStatus,
    };
    const supervisor = new SupervisorService(
      missionRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {
        listActiveMissionTaskIds: vi.fn(async () =>
          Array.from({ length: activeAttempts }, (_, i) => `t${i}`),
        ),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      releaseDelegation,
    );
    return { supervisor, releaseDelegation, updateMissionStatus };
  }

  it("settles once and releases once across repeated sweeps", async () => {
    const { supervisor, releaseDelegation, updateMissionStatus } = service(["succeeded"], 0);

    const first = await supervisor.settleIfComplete("m1");
    const second = await supervisor.settleIfComplete("m1");
    const third = await supervisor.settleIfComplete("m1");

    expect(first).toMatchObject({ settled: true, status: "succeeded" });
    expect(second).toMatchObject({ settled: false, reason: "MISSION_ALREADY_TERMINAL:succeeded" });
    expect(third).toMatchObject({ settled: false });
    expect(updateMissionStatus).toHaveBeenCalledTimes(1);
    expect(releaseDelegation).toHaveBeenCalledTimes(1);
    expect(releaseDelegation).toHaveBeenCalledWith("m1", "MISSION_SUCCEEDED");
  });

  it("a blocked mission gives its brains back too", async () => {
    const { supervisor, releaseDelegation } = service(["blocked", "succeeded"], 0);

    expect(await supervisor.settleIfComplete("m1")).toMatchObject({ status: "blocked" });
    expect(releaseDelegation).toHaveBeenCalledWith("m1", "MISSION_BLOCKED");
  });

  it("holds capacity while an attempt is still live on unfinished work", async () => {
    /* t0 is still running and carries the live attempt; t1 finished. */
    const { supervisor, releaseDelegation, updateMissionStatus } = service(["running", "succeeded"], 1);

    expect(await supervisor.settleIfComplete("m1")).toMatchObject({
      settled: false,
      reason: "TASK_NOT_TERMINAL:running",
    });
    expect(updateMissionStatus).not.toHaveBeenCalled();
    expect(releaseDelegation).not.toHaveBeenCalled();
  });
});
