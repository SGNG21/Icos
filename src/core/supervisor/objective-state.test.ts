import { describe, expect, it } from "vitest";

import { deriveObjectiveState, type ObjectiveStateInput } from "./objective-state";

const input = (over: Partial<ObjectiveStateInput> = {}): ObjectiveStateInput => ({
  goalStatus: "pending",
  missionId: null,
  mission: null,
  tasks: null,
  runtime: null,
  pendingApproval: false,
  controlHeld: false,
  tasksAwaitingRepair: null,
  ...over,
});

const task = (status: string) => ({ status });

describe("deriveObjectiveState", () => {
  it("RECEIVED when a goal exists and no mission does", () => {
    expect(deriveObjectiveState(input()).state).toBe("RECEIVED");
  });

  it("CONTEXTUALIZED when the mission exists but is still a draft", () => {
    const r = deriveObjectiveState(
      input({ missionId: "m", mission: { status: "draft" }, tasks: [] }),
    );
    expect(r.state).toBe("CONTEXTUALIZED");
  });

  it("PLANNING while the mission is planning", () => {
    expect(
      deriveObjectiveState(input({ missionId: "m", mission: { status: "planning" }, tasks: [] }))
        .state,
    ).toBe("PLANNING");
  });

  it("DELEGATING when tasks are queued and none is running", () => {
    expect(
      deriveObjectiveState(
        input({ missionId: "m", mission: { status: "ready" }, tasks: [task("queued")] }),
      ).state,
    ).toBe("DELEGATING");
  });

  it("EXECUTING when a task is running", () => {
    expect(
      deriveObjectiveState(
        input({ missionId: "m", mission: { status: "running" }, tasks: [task("running")] }),
      ).state,
    ).toBe("EXECUTING");
  });

  it("REVIEWING when a task is under review", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("running"), task("review_pending")],
        }),
      ).state,
    ).toBe("REVIEWING");
  });

  it("REPAIRING when a non-terminal task carries a changes-requested review", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("queued")],
          tasksAwaitingRepair: 1,
        }),
      ).state,
    ).toBe("REPAIRING");
  });

  it("DECISION_READY when every task is settled but the mission is not", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("succeeded"), task("succeeded")],
        }),
      ).state,
    ).toBe("DECISION_READY");
  });

  it("WAITING_FOR_HUMAN on a pending approval request", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("running")],
          pendingApproval: true,
        }),
      ).state,
    ).toBe("WAITING_FOR_HUMAN");
  });

  it("WAITING_FOR_HUMAN when the mission itself awaits approval", () => {
    expect(
      deriveObjectiveState(
        input({ missionId: "m", mission: { status: "awaiting_approval" }, tasks: [task("queued")] }),
      ).state,
    ).toBe("WAITING_FOR_HUMAN");
  });

  it("BLOCKED with a reason when a control hold is in force", () => {
    const r = deriveObjectiveState(
      input({
        missionId: "m",
        mission: { status: "running" },
        tasks: [task("running")],
        controlHeld: true,
      }),
    );
    expect(r.state).toBe("BLOCKED");
    expect(r.blockedReason).toBe("control_hold");
  });

  it("BLOCKED with a reason when the mission is blocked", () => {
    const r = deriveObjectiveState(
      input({ missionId: "m", mission: { status: "blocked" }, tasks: [task("queued")] }),
    );
    expect(r.state).toBe("BLOCKED");
    expect(r.blockedReason).toBe("mission_blocked");
  });

  it("RECOVERING when the runtime says so", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("queued")],
          runtime: { state: "recovering" },
        }),
      ).state,
    ).toBe("RECOVERING");
  });

  it.each([
    ["succeeded", "COMPLETED"],
    ["failed", "FAILED"],
    ["cancelled", "CANCELLED"],
  ])("maps terminal mission %s to %s", (missionStatus, expected) => {
    expect(
      deriveObjectiveState(input({ missionId: "m", mission: { status: missionStatus }, tasks: [] }))
        .state,
    ).toBe(expected);
  });

  it("unreadable mission degrades, never reports RECEIVED", () => {
    const r = deriveObjectiveState(input({ missionId: "m-gone", mission: null }));
    expect(r.state).toBe("DEGRADED");
    expect(r.unknown).toContain("mission");
    expect(r.state).not.toBe("RECEIVED");
  });

  it("names tasks as unknown when the mission is readable but its tasks are not", () => {
    const r = deriveObjectiveState(
      input({ missionId: "m", mission: { status: "running" }, tasks: null }),
    );
    expect(r.state).toBe("DEGRADED");
    expect(r.unknown).toContain("tasks");
  });

  it("names repairState as unknown when review history is unavailable", () => {
    const r = deriveObjectiveState(
      input({
        missionId: "m",
        mission: { status: "running" },
        tasks: [task("queued")],
        tasksAwaitingRepair: null,
      }),
    );
    expect(r.unknown).toContain("repairState");
    expect(r.state).not.toBe("REPAIRING");
  });

  it("is a pure function of its input", () => {
    const i = input({ missionId: "m", mission: { status: "running" }, tasks: [task("running")] });
    expect(deriveObjectiveState(i)).toEqual(deriveObjectiveState(i));
  });
});
