import { describe, expect, it, vi } from "vitest";

import { POLICY_VERSION } from "@/core/autonomy/execution-risk-policy";
import type { Task } from "@/core/contracts";
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { buildMemoryContainer } from "@/server/container";
import type { TaskExecutionDispatcher, TaskExecutionDispatchInput } from "@/server/execution/ports";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { TaskRiskGate } from "@/server/supervisor/task-risk-gate";
import { approveRiskGatedTasks } from "@/server/usecases/approve-risk-gated-tasks";

type GoalOverrides = Partial<Pick<HighLevelGoal, "allowedCapabilities" | "humanApprovalPolicy" | "riskLevel">>;

function goalOf(id: string, overrides: GoalOverrides = {}): HighLevelGoal {
  return {
    id,
    title: "G",
    objective: "O",
    rawInput: "O",
    normalizedIntent: "O",
    constraints: [],
    successCriteria: [],
    priority: 3,
    riskLevel: "reversible",
    allowedCapabilities: ["research", "code_write"],
    forbiddenCapabilities: [],
    humanApprovalPolicy: "if_risky",
    metadata: {},
    createdAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

type PlanTask = {
  title: string;
  requiredCapabilities?: string[];
  riskClass?: "read_only" | "reversible" | "sensitive";
  allowedFileScope?: string[];
};

async function setup(opts: {
  tasks: PlanTask[];
  goal?: GoalOverrides | "missing" | "throws";
  gate?: boolean;
  coordinator?: unknown;
}) {
  const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
  const goalId = opts.goal === undefined ? undefined : "goal-risk-1";
  const mission = await container.mission.create({
    title: "Risk gate",
    objective: "risk gate",
    goalId,
    tasks: opts.tasks.map((t) => ({
      title: t.title,
      description: t.title,
      dependsOn: [],
      workerKind: "agent",
      requiredCapabilities: t.requiredCapabilities,
      riskClass: t.riskClass,
      allowedFileScope: t.allowedFileScope,
    })) as never,
  });
  const goals = {
    getById: vi.fn(async (id: string) => {
      if (opts.goal === "throws") throw new Error("goal store down");
      if (opts.goal === "missing" || opts.goal === undefined) return null;
      return { goal: goalOf(id, opts.goal), preview: {} as never };
    }),
  };
  const attempts = new InMemoryDispatchAttemptRepository(container.mission, container.tasks);
  const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));
  const gate = new TaskRiskGate({
    tasks: container.tasks,
    missions: container.mission,
    goals,
    audit: container.audit,
  });
  const supervisor = new SupervisorService(
    container.mission,
    container.tasks,
    { dispatch } as TaskExecutionDispatcher,
    container.durableMemory,
    attempts,
    opts.coordinator as never,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.gate === false ? undefined : gate,
  );
  const missionTasks = await container.mission.listTasks(mission.id);
  const byTitle = (title: string) => missionTasks.find((t) => t.title === title)!;
  const statusOf = async (title: string) =>
    (await container.mission.listTasks(mission.id)).find((t) => t.title === title)!.status;
  const canonicalStatusOf = async (title: string) =>
    (await container.tasks.getById(byTitle(title).taskId))!.status;
  const dispatchedTitles = () => dispatch.mock.calls.map(([input]) => input.taskTitle);
  const attemptsFor = async (title: string) =>
    attempts.listNonTerminalByMissionTaskId(byTitle(title).id);
  const approve = () =>
    approveRiskGatedTasks(
      { missions: container.mission, tasks: container.tasks, audit: container.audit },
      { missionId: mission.id, approver: { kind: "human", id: "owner-1" } },
    );
  return {
    container,
    mission,
    supervisor,
    dispatch,
    byTitle,
    statusOf,
    canonicalStatusOf,
    dispatchedTitles,
    attemptsFor,
    approve,
  };
}

describe("supervisor dispatch risk gate", () => {
  it("dispatches the read-only task and parks the deploy task with no attempt", async () => {
    const f = await setup({
      goal: {},
      tasks: [{ title: "inspect", riskClass: "read_only" }, { title: "ship", requiredCapabilities: ["deploy"] }],
    });

    await f.supervisor.run(f.mission.id);

    expect(f.dispatchedTitles()).toEqual(["inspect"]);
    expect(await f.statusOf("ship")).toBe("awaiting_approval");
    expect(await f.canonicalStatusOf("ship")).toBe("awaiting_approval");
    expect(await f.attemptsFor("ship")).toEqual([]);
    expect((await f.container.mission.findById(f.mission.id))?.status).toBe("awaiting_approval");

    const audit = await f.container.audit.query({
      taskId: f.byTitle("ship").taskId,
      eventType: "task.transitioned",
    });
    const park = audit.find((e) => e.details.to === "awaiting_approval");
    expect(park?.actor).toEqual({ kind: "system", id: "icos-risk-gate" });
    expect(park?.details.riskGate).toMatchObject({
      decision: "APPROVAL_REQUIRED",
      riskClass: "IRREVERSIBLE",
      policyVersion: POLICY_VERSION,
    });
  });

  it("after a human approval dispatches the parked task exactly once, across repeated ticks", async () => {
    const f = await setup({
      goal: {},
      tasks: [{ title: "inspect", riskClass: "read_only" }, { title: "ship", requiredCapabilities: ["deploy"] }],
    });
    await f.supervisor.run(f.mission.id);
    /* Ticks before the approval change nothing. */
    await f.supervisor.run(f.mission.id);
    expect(f.dispatchedTitles()).toEqual(["inspect"]);

    const approval = await f.approve();
    expect(approval.released).toEqual([f.byTitle("ship").id]);
    expect(await f.canonicalStatusOf("ship")).toBe("queued");

    await f.supervisor.run(f.mission.id);
    await f.supervisor.run(f.mission.id);
    await f.supervisor.run(f.mission.id);

    expect(f.dispatchedTitles().filter((t) => t === "ship")).toHaveLength(1);
    const approvalEntry = (
      await f.container.audit.query({ taskId: f.byTitle("ship").taskId, eventType: "task.transitioned" })
    ).find((e) => e.details.from === "awaiting_approval" && e.details.to === "queued");
    expect(approvalEntry?.actor).toEqual({ kind: "human", id: "owner-1" });
    expect(approvalEntry?.details.riskGate).toMatchObject({ decision: "APPROVED", riskClass: "IRREVERSIBLE" });

    /* A second approval call is a no-op: nothing is parked any more. */
    expect((await f.approve()).released).toEqual([]);
  });

  it("an approval is bound to what was classified: a changed task is parked again", async () => {
    const f = await setup({ goal: {}, tasks: [{ title: "ship", requiredCapabilities: ["deploy"] }] });
    await f.supervisor.run(f.mission.id);
    await f.approve();

    /* The task now also deletes data: a different classification, not the one approved. */
    const store = (f.container.tasks as unknown as { tasks: Task[] }).tasks;
    store.find((t) => t.id === f.byTitle("ship").taskId)!.requiredCapabilities = ["deploy", "data_delete"];

    await f.supervisor.run(f.mission.id);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.statusOf("ship")).toBe("awaiting_approval");
    expect(await f.canonicalStatusOf("ship")).toBe("awaiting_approval");
  });

  it("a capability outside the goal's allowlist needs a human", async () => {
    const f = await setup({
      goal: { allowedCapabilities: ["research"] },
      tasks: [{ title: "plan", riskClass: "read_only", requiredCapabilities: ["planning"] }],
    });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.statusOf("plan")).toBe("awaiting_approval");
  });

  it("owner policy `always` parks even read-only work", async () => {
    const f = await setup({ goal: { humanApprovalPolicy: "always" }, tasks: [{ title: "inspect", riskClass: "read_only" }] });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.statusOf("inspect")).toBe("awaiting_approval");
  });

  it("a planner-chosen `sensitive` risk escalates; `read_only` relaxes nothing", async () => {
    const f = await setup({
      goal: {},
      tasks: [
        { title: "risky", riskClass: "sensitive" },
        { title: "claims-safe", riskClass: "read_only", requiredCapabilities: ["data_delete"] },
      ],
    });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.statusOf("risky")).toBe("awaiting_approval");
    expect(await f.statusOf("claims-safe")).toBe("awaiting_approval");
  });

  it("an unclassified capability fails closed", async () => {
    /* No goal allowlist, so only the unclassified-capability rule can refuse it. */
    const f = await setup({
      goal: { allowedCapabilities: [] },
      tasks: [{ title: "x", requiredCapabilities: ["quantum_teleport"] }],
    });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.statusOf("x")).toBe("awaiting_approval");
  });

  it("a task with no declared class is a writer, as for workspace allocation", async () => {
    /* `riskClass` defaults to `reversible`: an undeclared task is never assumed read-only. */
    const f = await setup({ goal: {}, tasks: [{ title: "undeclared" }] });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.statusOf("undeclared")).toBe("awaiting_approval");
  });

  it("a writer with no isolated workspace is escalated", async () => {
    const f = await setup({ goal: {}, tasks: [{ title: "write", allowedFileScope: ["docs/"] }] });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await f.statusOf("write")).toBe("awaiting_approval");
  });

  it("fails closed when the goal cannot be read, and such a park is not approvable", async () => {
    for (const goal of ["missing", "throws"] as const) {
      const f = await setup({ goal, tasks: [{ title: "inspect", riskClass: "read_only" }] });
      await f.supervisor.run(f.mission.id);
      expect(f.dispatch, goal).not.toHaveBeenCalled();
      expect(await f.statusOf("inspect"), goal).toBe("awaiting_approval");
      expect((await f.approve()).skipped, goal).toEqual([
        { missionTaskId: f.byTitle("inspect").id, reason: "NOTHING_APPROVABLE" },
      ]);
    }
  });

  it("a mission without a goal is classified from its tasks alone", async () => {
    const f = await setup({ tasks: [{ title: "inspect", riskClass: "read_only" }, { title: "pay", requiredCapabilities: ["payment"] }] });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatchedTitles()).toEqual(["inspect"]);
    expect(await f.statusOf("pay")).toBe("awaiting_approval");
  });

  it("approval leaves a task parked by something else (reviewer escalation) alone", async () => {
    const f = await setup({ goal: {}, tasks: [{ title: "inspect", riskClass: "read_only" }] });
    await f.container.mission.updateMissionTaskStatus(f.mission.id, f.byTitle("inspect").id, "awaiting_approval");
    expect((await f.approve()).skipped).toEqual([
      { missionTaskId: f.byTitle("inspect").id, reason: "NOT_RISK_GATED" },
    ]);
    expect(await f.statusOf("inspect")).toBe("awaiting_approval");
  });

  it("an isolated writer (governed workspace) is AUTONOMOUS; an ungovernable one is still BLOCKED", async () => {
    const coordinator = {
      retireSupersededWorkspaces: vi.fn(async () => undefined),
      allocateWorkspace: vi.fn(async () => ({ workspaceId: "ws-1" })),
      executeInWorkspace: vi.fn(async () => ({ success: true, awaitingReview: true })),
      releaseWorkspace: vi.fn(async () => undefined),
    };
    const f = await setup({
      goal: {},
      coordinator,
      tasks: [
        { title: "write", allowedFileScope: ["docs/"] },
        { title: "no-scope" },
      ],
    });
    await f.supervisor.run(f.mission.id);
    expect(coordinator.allocateWorkspace).toHaveBeenCalledTimes(1);
    expect(coordinator.executeInWorkspace).toHaveBeenCalledTimes(1);
    /* REFUSED by the allocation policy: no approval could govern it, so it blocks as before. */
    expect(await f.statusOf("no-scope")).toBe("blocked");
  });

  it("reports whether the gate is enforced, and under which policy", async () => {
    const gated = await setup({ goal: {}, tasks: [{ title: "a" }] });
    expect(gated.supervisor.riskGate).toEqual({ enforced: true, policyVersion: POLICY_VERSION });
    const ungated = await setup({ goal: {}, tasks: [{ title: "a" }], gate: false });
    expect(ungated.supervisor.riskGate).toEqual({ enforced: false, policyVersion: POLICY_VERSION });
  });

  it("without the gate, dispatch is byte-identical to before (the deploy task dispatches)", async () => {
    const f = await setup({
      goal: {},
      tasks: [{ title: "ship", requiredCapabilities: ["deploy"] }],
      gate: false,
    });
    await f.supervisor.run(f.mission.id);
    expect(f.dispatchedTitles()).toEqual(["ship"]);
  });
});
