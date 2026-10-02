import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import { ObjectiveCoordinator } from "./objective-coordinator";
import { buildObjectiveReadModel } from "./objective-read-model";

/**
 * SUPERVISOR_E2E — one user objective, two workers, an independent review, one repair
 * cycle, a completed result. Entirely in memory: no live DB, no external call, no
 * destructive action. It proves the lane's own claim (admission + truthful projection)
 * against a simulated run of the canonical pipeline, not a reimplementation of it.
 */

const NOW = new Date("2026-10-02T12:00:00.000Z");

const userGoal: HighLevelGoal = {
  id: "g-lds",
  title: "Occupe-toi de LDS",
  objective: "audit and fix the LDS contact form",
  rawInput: "Occupe-toi de LDS",
  normalizedIntent: "audit and fix the LDS contact form",
  constraints: [],
  successCriteria: ["form submits"],
  priority: 4,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: { "icos.source": "cognitive_conversation" },
  createdAt: "2026-10-02T11:00:00.000Z",
};

describe("SUPERVISOR_E2E", () => {
  it("objective → admission → plan → 2 workers → review → repair → completed", async () => {
    // --- world -----------------------------------------------------------------
    let missionStatus = "planning";
    let tasks = [
      { taskId: "t-audit", status: "queued", workerKind: "research" },
      { taskId: "t-fix", status: "queued", workerKind: "engineering" },
    ];
    const reviews: { taskId: string; decision: string; reasons: string[]; createdAt: string }[] =
      [];
    let converted = false;

    const enqueued: Record<string, unknown>[] = [];
    const scheduler = {
      enqueue: vi.fn(async (input: Record<string, unknown>) => {
        enqueued.push(input);
        return { job: { id: "job-1", missionId: "m-lds" }, created: true };
      }),
    };

    const goals = {
      list: vi.fn(async (filter?: { status?: string }) => {
        const record = {
          goal: userGoal,
          status: converted ? "converted" : "pending",
          resultingMissionId: converted ? "m-lds" : null,
          convertedAt: converted ? NOW.toISOString() : null,
        };
        if (filter?.status && filter.status !== record.status) return [];
        return [record];
      }),
    };

    const missions = {
      list: vi.fn(async () => (converted ? [{ id: "m-lds", status: missionStatus }] : [])),
      findById: vi.fn(async (id: string) =>
        converted && id === "m-lds" ? { id: "m-lds", status: missionStatus } : null,
      ),
      listTasks: vi.fn(async () => tasks),
    };

    const readModel = () =>
      buildObjectiveReadModel({
        goals: goals as never,
        missions: missions as never,
        reviews: { listByMissionId: async () => reviews },
        runtimes: { get: async () => (missionStatus === "running" ? { state: "running" } : null) },
        controlHolds: { isHeld: async () => false },
        visibility: { unconvertedVisible: true, isMissionVisible: async () => true },
        now: () => NOW,
      });

    // --- 1. admission ----------------------------------------------------------
    const coordinator = new ObjectiveCoordinator({
      scheduler: scheduler as never,
      goals: goals as never,
      missions: missions as never,
      now: () => NOW,
    });

    const admission = await coordinator.admit({
      goal: userGoal,
      idempotencyKey: "e2e-1",
      title: userGoal.title,
      objective: userGoal.objective,
    });

    expect(admission.outcome).toBe("enqueued");
    expect(admission.evidence.priority.class).toBe("USER");
    expect(enqueued[0]).toMatchObject({ kind: "start_mission" });
    expect(enqueued[0].priority as number).toBeGreaterThan(80);
    // Exactly one job: no second scheduler, no second executor.
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);

    // --- 2. the canonical runner plans and the mission becomes real -------------
    converted = true;
    expect((await readModel())[0].state).toBe("PLANNING");

    // --- 3. two workers execute in parallel ------------------------------------
    missionStatus = "running";
    tasks = [
      { taskId: "t-audit", status: "running", workerKind: "research" },
      { taskId: "t-fix", status: "running", workerKind: "engineering" },
    ];
    const executing = (await readModel())[0];
    expect(executing.state).toBe("EXECUTING");
    expect(executing.assignedWorkers).toEqual(["engineering", "research"]);
    expect(executing.progress).toEqual({ tasksTotal: 2, tasksSettled: 0 });

    // --- 4. independent review asks for changes on one task --------------------
    tasks = [
      { taskId: "t-audit", status: "succeeded", workerKind: "research" },
      { taskId: "t-fix", status: "review_pending", workerKind: "engineering" },
    ];
    expect((await readModel())[0].state).toBe("REVIEWING");

    reviews.push({
      taskId: "t-fix",
      decision: "REQUEST_CHANGES",
      reasons: ["validation missing on the email field"],
      createdAt: "2026-10-02T11:40:00.000Z",
    });
    tasks = [
      { taskId: "t-audit", status: "succeeded", workerKind: "research" },
      { taskId: "t-fix", status: "queued", workerKind: "engineering" },
    ];

    // --- 5. one repair cycle ---------------------------------------------------
    const repairing = (await readModel())[0];
    expect(repairing.state).toBe("REPAIRING");
    expect(repairing.reviewState).toBe("REQUEST_CHANGES");
    expect(repairing.latestMeaningfulResult).toContain("validation missing");

    // --- 6. the repair is approved and the mission settles ---------------------
    reviews.push({
      taskId: "t-fix",
      decision: "APPROVE",
      reasons: ["validation added"],
      createdAt: "2026-10-02T11:55:00.000Z",
    });
    tasks = [
      { taskId: "t-audit", status: "succeeded", workerKind: "research" },
      { taskId: "t-fix", status: "succeeded", workerKind: "engineering" },
    ];
    expect((await readModel())[0].state).toBe("DECISION_READY");

    missionStatus = "succeeded";
    const completed = (await readModel())[0];
    expect(completed.state).toBe("COMPLETED");
    expect(completed.progress).toEqual({ tasksTotal: 2, tasksSettled: 2 });
    expect(completed.reviewState).toBe("APPROVE");
    // Cost is not measured anywhere in CORE3 today, and is reported as such.
    expect(completed.cost).toBe("UNKNOWN");
    expect(completed.degraded).toBeNull();
  });
});
