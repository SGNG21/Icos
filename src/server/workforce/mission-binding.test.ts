import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import type { ChiefDelegation, ChiefDelegationOutcome } from "./chief-delegation";
import type { WorkforceTaskCompute } from "./core3-task-compute";
import { boundTaskCompute } from "./mission-binding";

/**
 * THE BRIDGE (decision 0070): Chief binds per CORE3 task at first routing, idempotently,
 * never fatally, and the inner seam keeps matching on the durable task id.
 */
const goal = { id: "g-1", objective: "o" } as HighLevelGoal;
const ok = (over: Partial<Extract<ChiefDelegationOutcome, { ok: true }>> = {}) =>
  ({
    ok: true,
    plan: {} as never,
    assignments: [],
    gaps: [],
    unbound: [],
    alreadyBound: 0,
    released: 0,
    ...over,
  }) as ChiefDelegationOutcome;

function harness(opts: {
  goalId?: string;
  tasks?: { taskId: string; capability?: string | null; status?: string }[];
  outcome?: ChiefDelegationOutcome | Error;
}) {
  const tasks = opts.tasks ?? [{ taskId: "task-1", capability: null }];
  const delegateGoal = vi.fn(async () => {
    if (opts.outcome instanceof Error) throw opts.outcome;
    return opts.outcome ?? ok();
  });
  const inner: WorkforceTaskCompute = { forTask: vi.fn(async () => null) };
  const report = vi.fn();
  const compute = boundTaskCompute(inner, {
    missions: {
      findById: async (id) => ({ id, goalId: opts.goalId }),
      listTasks: async () => tasks as never,
    },
    goals: { getById: async () => ({ goal }) },
    chief: { delegateGoal } as unknown as ChiefDelegation,
    report,
  });
  return { compute, delegateGoal, inner, report, tasks };
}

describe("boundTaskCompute", () => {
  it("binds the mission on first routing with the CORE3 tasks, then reads through the inner seam", async () => {
    const h = harness({ goalId: "g-1" });
    await h.compute.forTask("m-1", "task-1");
    expect(h.delegateGoal).toHaveBeenCalledWith(goal, "m-1", h.tasks);
    expect(h.inner.forTask).toHaveBeenCalledWith("m-1", "task-1");
  });

  it("is idempotent per task set: a second routing pass delegates nothing, a replan re-binds", async () => {
    const tasks = [{ taskId: "task-1", capability: null }];
    const h = harness({ goalId: "g-1", tasks });
    await h.compute.forTask("m-1", "task-1");
    await h.compute.forTask("m-1", "task-1");
    expect(h.delegateGoal).toHaveBeenCalledTimes(1);
    tasks.push({ taskId: "task-2", capability: null });
    await h.compute.forTask("m-1", "task-2");
    expect(h.delegateGoal).toHaveBeenCalledTimes(2);
  });

  it("a task finishing changes the fingerprint, so its slot can be released on the next pass", async () => {
    const tasks = [{ taskId: "task-1", capability: null, status: "queued" }];
    const h = harness({ goalId: "g-1", tasks });
    await h.compute.forTask("m-1", "task-1");
    tasks[0] = { ...tasks[0]!, status: "succeeded" };
    await h.compute.forTask("m-1", "task-1");
    expect(h.delegateGoal).toHaveBeenCalledTimes(2);
  });

  it("a mission without a goal is never delegated: nothing to classify, nothing invented", async () => {
    const h = harness({ goalId: undefined });
    await h.compute.forTask("m-1", "task-1");
    expect(h.delegateGoal).not.toHaveBeenCalled();
    expect(h.inner.forTask).toHaveBeenCalled();
  });

  it("a refusal or a failure is reported and never blocks the dispatch", async () => {
    const refused = harness({
      goalId: "g-1",
      outcome: { ok: false, refusals: ["NO_SHAPE_FOR_WORK_CLASS"], classified: {} as never },
    });
    expect(await refused.compute.forTask("m-1", "task-1")).toBeNull();
    expect(refused.report).toHaveBeenCalledWith(
      expect.objectContaining({ event: "CHIEF_DELEGATION_REFUSED" }),
    );
    const failed = harness({ goalId: "g-1", outcome: new Error("db down") });
    expect(await failed.compute.forTask("m-1", "task-1")).toBeNull();
    expect(failed.report).toHaveBeenCalledWith(
      expect.objectContaining({ event: "CHIEF_DELEGATION_FAILED", error: "db down" }),
    );
    expect(failed.inner.forTask).toHaveBeenCalled();
  });

  it("a partial delegation is reported with the unbound tasks and the governance gaps", async () => {
    const h = harness({
      goalId: "g-1",
      outcome: ok({
        unbound: [{ taskId: "task-x", capability: "seo_audit" }],
        gaps: [
          {
            request: { taskId: "task-1", requiredAgentId: "brain-planner" },
            reason: "CONCURRENCY_LIMIT",
            rejected: [{ agentId: "brain-planner", violations: ["CONCURRENCY_LIMIT"] }],
          } as never,
        ],
      }),
    });
    await h.compute.forTask("m-1", "task-1");
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "CHIEF_DELEGATION_PARTIAL",
        unboundTasks: ["task-x"],
        gaps: [expect.objectContaining({ taskId: "task-1", reason: "CONCURRENCY_LIMIT" })],
      }),
    );
  });

  it("an unplaced Reviewer is reported on its own line, and only the Reviewer", async () => {
    const h = harness({
      goalId: "g-1",
      outcome: ok({
        gaps: [
          {
            request: { taskId: "m-1:review", requiredAgentId: "brain-reviewer" },
            reason: "CONCURRENCY_LIMIT",
            rejected: [],
          } as never,
        ],
      }),
    });
    await h.compute.forTask("m-1", "task-1");
    expect(h.report).toHaveBeenCalledWith({
      event: "CHIEF_DELEGATION_REVIEWER_UNPLACED",
      missionId: "m-1",
      goalId: "g-1",
      brainId: "brain-reviewer",
      reason: "CONCURRENCY_LIMIT",
    });

    const other = harness({
      goalId: "g-1",
      outcome: ok({
        gaps: [
          {
            request: { taskId: "task-1", requiredAgentId: "brain-planner" },
            reason: "CONCURRENCY_LIMIT",
            rejected: [],
          } as never,
        ],
      }),
    });
    await other.compute.forTask("m-1", "task-1");
    expect(other.report).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "CHIEF_DELEGATION_REVIEWER_UNPLACED" }),
    );
  });

  it("nothing in a task, a plan or a request can name a brain: the binding reads only Chief", async () => {
    const h = harness({
      goalId: "g-1",
      tasks: [{ taskId: "task-1", capability: null, brainId: "brain-evolution" } as never],
    });
    await h.compute.forTask("m-1", "task-1");
    /* The task list is handed to Chief as-is; Chief's policy ignores any foreign field. */
    const [, , tasks] = h.delegateGoal.mock.calls[0]! as unknown as [unknown, unknown, unknown[]];
    expect(tasks).toHaveLength(1);
    expect(h.delegateGoal).toHaveBeenCalledTimes(1);
  });
});
