import { describe, expect, it } from "vitest";

import {
  createHarness,
  ScriptedReviewer,
  ScriptedWorkerDispatcher,
  FixedPlanPlanner,
  singleTaskPlan,
  type ScriptedReviewStep,
} from "@/server/usecases/phase6-e2e-harness";
import type { MissionPlan } from "@/server/mission/mission-plan";
import { AutonomousMissionRunner } from "@/server/autonomy/autonomous-mission-runner";

/**
 * Phase 6 — TRUE autonomous end-to-end deterministic proofs.
 *
 * Each scenario begins from ONE objective and touches nothing manually except
 * emitting worker callbacks (the external boundary). Every ICOS transition —
 * planning, dispatch, review, accept/correct/retry/replan, recovery, ownership,
 * completion gating — is the production code path.
 */

function reviewerFor(steps: Record<string, ScriptedReviewStep[]>): ScriptedReviewer {
  return new ScriptedReviewer(new Map(Object.entries(steps)));
}

/** Resolve the canonical taskId of the mission's first (only) task. */
async function firstTaskId(
  h: ReturnType<typeof createHarness>,
  missionId: string,
): Promise<string> {
  const tasks = await h.listTasks(missionId);
  return tasks[0].taskId;
}

describe("Phase 6 — autonomous E2E (deterministic)", () => {
  it("SCENARIO 1 — HAPPY PATH: objective → plan → dispatch → APPROVE → mission complete", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    // Reviewer keyed by canonical taskId, resolved after planning.
    const dispatcher = new ScriptedWorkerDispatcher();
    // We don't know the taskId until after planning, so use a permissive
    // reviewer that approves everything.
    const reviewer = new (class {
      reviewCalls = 0;
      async review(input: import("@/server/review/ports").ReviewInput) {
        this.reviewCalls += 1;
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision: "APPROVE" as const,
          reviewerKind: "llm" as const,
          severity: "info" as const,
          reasons: ["Independent APPROVE"],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();

    const h = createHarness({ planner, reviewer, dispatcher });
    const mission = await h.ignite({ title: "Ship it", objective: "Produce the deliverable" });

    // Exactly one task planned and dispatched with deterministic workflow id.
    const tasks = await h.listTasks(mission.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("queued");
    expect(dispatcher.dispatches).toHaveLength(1);
    expect(dispatcher.dispatches[0].workflowId).toBe(`icos-task-${tasks[0].taskId}`);

    // Worker completes → callback → independent APPROVE → ACCEPT → complete.
    const final = await h.runToCompletion(mission.id);
    expect(final.status).toBe("succeeded");
    expect(reviewer.reviewCalls).toBe(1);

    const finalTasks = await h.listTasks(mission.id);
    expect(finalTasks.every((t) => t.status === "succeeded")).toBe(true);
  });

  it("SCENARIO 2 — CORRECTION: imperfect result → REQUEST_CHANGES → corrected → APPROVE → complete", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    let call = 0;
    const reviewer = new (class {
      reviewCalls = 0;
      async review(input: import("@/server/review/ports").ReviewInput) {
        this.reviewCalls += 1;
        call += 1;
        const decision = call === 1 ? ("REQUEST_CHANGES" as const) : ("APPROVE" as const);
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision,
          reviewerKind: "llm" as const,
          severity: decision === "APPROVE" ? ("info" as const) : ("warning" as const),
          reasons: [`Reviewer chose ${decision}`],
          requestedChanges:
            decision === "REQUEST_CHANGES"
              ? [{ field: "output", reason: "insufficient detail", suggestion: "add evidence" }]
              : undefined,
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();
    const dispatcher = new ScriptedWorkerDispatcher();
    const h = createHarness({ planner, reviewer, dispatcher });

    const mission = await h.ignite({
      title: "Correctable",
      objective: "Produce evidence-backed output",
    });
    const taskId = await firstTaskId(h, mission.id);

    const final = await h.runToCompletion(mission.id);
    expect(final.status).toBe("succeeded");

    // A correction attempt was dispatched with a distinct deterministic id and
    // a correction prompt carrying the reviewer feedback.
    expect(dispatcher.dispatches.length).toBeGreaterThanOrEqual(2);
    const correction = dispatcher.dispatches.find((d) => d.workflowId.includes("attempt-2"));
    expect(correction, "second deterministic attempt dispatched").toBeTruthy();
    expect(correction!.taskId).toBe(taskId);
    expect(correction!.prompt).toContain("Correction requested");
    expect(reviewer.reviewCalls).toBe(2);
  });

  it("SCENARIO 3 — RETRY: retry-worthy failure → RETRY → second deterministic attempt → success", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    let call = 0;
    const reviewer = new (class {
      reviewCalls = 0;
      async review(input: import("@/server/review/ports").ReviewInput) {
        this.reviewCalls += 1;
        call += 1;
        const decision = call === 1 ? ("RETRY" as const) : ("APPROVE" as const);
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision,
          reviewerKind: "llm" as const,
          severity: decision === "APPROVE" ? ("info" as const) : ("warning" as const),
          reasons: [`Reviewer chose ${decision}`],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();
    const dispatcher = new ScriptedWorkerDispatcher();
    const h = createHarness({ planner, reviewer, dispatcher });

    const mission = await h.ignite({
      title: "Retryable",
      objective: "Survive a transient failure",
    });
    const taskId = await firstTaskId(h, mission.id);

    // First worker reports failure; retry then succeeds.
    let firstDone = false;
    const final = await h.runToCompletion(mission.id, (d) => {
      if (!firstDone && d.workflowId === `icos-task-${taskId}`) {
        firstDone = true;
        return { outcome: "failure", error: { code: "WORKER_TIMEOUT", message: "boom" } };
      }
      return { outcome: "success" };
    });

    expect(final.status).toBe("succeeded");
    const retry = dispatcher.dispatches.find((d) => d.workflowId.includes("attempt-2"));
    expect(retry, "deterministic retry attempt dispatched").toBeTruthy();
    expect(retry!.taskId).toBe(taskId);
  });

  it("SCENARIO 4 — REPLAN: unacceptable structural result → REPLAN → atomic replacement → APPROVE → complete", async () => {
    const initialPlan: MissionPlan = singleTaskPlan("bad", "Structurally wrong approach");
    const replacementPlan: MissionPlan = singleTaskPlan("good", "Correct approach");
    const planner = new FixedPlanPlanner([initialPlan, replacementPlan]);

    let call = 0;
    const reviewer = new (class {
      reviewCalls = 0;
      async review(input: import("@/server/review/ports").ReviewInput) {
        this.reviewCalls += 1;
        call += 1;
        // First result → REPLAN; the replacement task → APPROVE.
        const decision = call === 1 ? ("REPLAN" as const) : ("APPROVE" as const);
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision,
          reviewerKind: "llm" as const,
          severity: decision === "APPROVE" ? ("info" as const) : ("warning" as const),
          reasons: [`Reviewer chose ${decision}`],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();
    const dispatcher = new ScriptedWorkerDispatcher();
    const h = createHarness({ planner, reviewer, dispatcher });

    const mission = await h.ignite({
      title: "Replannable",
      objective: "Reach the objective even if the first graph is wrong",
    });
    const originalTaskId = await firstTaskId(h, mission.id);

    const final = await h.runToCompletion(mission.id);
    expect(final.status).toBe("succeeded");

    // Planner was called twice (initial + replan). Original task superseded,
    // replacement task succeeded, succeeded history preserved.
    expect(planner.planCalls).toBe(2);
    const tasks = await h.listTasks(mission.id);
    const original = tasks.find((t) => t.taskId === originalTaskId);
    expect(original?.status).toBe("superseded");
    expect(tasks.some((t) => t.taskId !== originalTaskId && t.status === "succeeded")).toBe(true);
  });

  it("SCENARIO 5 — CRASH/RECOVERY: crash between dispatch and callback → recovery converges without duplicate work", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    const reviewer = reviewerFor({});
    // Approve everything by taskId once known.
    const approving = new (class {
      reviewCalls = 0;
      async review(input: import("@/server/review/ports").ReviewInput) {
        this.reviewCalls += 1;
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision: "APPROVE" as const,
          reviewerKind: "llm" as const,
          severity: "info" as const,
          reasons: ["APPROVE"],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();
    void reviewer;
    const dispatcher = new ScriptedWorkerDispatcher();
    const h = createHarness({ planner, reviewer: approving, dispatcher });

    const mission = await h.ignite({ title: "Crashy", objective: "Survive a mid-flight crash" });
    const taskId = await firstTaskId(h, mission.id);
    expect(dispatcher.dispatches).toHaveLength(1);

    // Simulate a crash: the runtime was left owned with an expired lease
    // (owner died). A fresh recovery sweep must re-claim and resume, and the
    // worker callback (same deterministic workflowId) must not duplicate work.
    const rt = await h.runtimeRepository.get(mission.id);
    expect(rt).toBeTruthy();
    await h.runtimeRepository.save({
      ...rt!,
      state: "running",
      ownerToken: "dead-owner",
      leaseUntil: new Date(Date.now() - 60_000),
    });

    // Recovery sweep discovers the abandoned runtime and resumes it.
    const sweep = await h.recoverySweeper.sweep();
    expect(sweep.discovered).toBeGreaterThanOrEqual(1);

    // No duplicate dispatch for the same deterministic workflow id.
    const dispatchIds = dispatcher.dispatches.map((d) => d.workflowId);
    expect(dispatchIds.filter((id) => id === `icos-task-${taskId}`)).toHaveLength(1);

    // The worker callback still lands and completes the mission.
    const final = await h.runToCompletion(mission.id);
    expect(final.status).toBe("succeeded");
  });

  it("SCENARIO 6 — CONCURRENT RUNNERS: only the lease owner may mutate; the loser fails closed", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    const approving = new (class {
      async review(input: import("@/server/review/ports").ReviewInput) {
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision: "APPROVE" as const,
          reviewerKind: "llm" as const,
          severity: "info" as const,
          reasons: ["APPROVE"],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();
    const h = createHarness({ planner, reviewer: approving });
    const mission = await h.ignite({ title: "Contended", objective: "Only one owner mutates" });

    // Two competing runners contend for the same mission runtime.
    const makeRunner = () =>
      new AutonomousMissionRunner(
        h.missions,
        h.supervisor,
        planner,
        { maxCycles: 10, maxRuntimeMs: 3_600_000, maxStagnationCycles: 3, maxReplans: 5 },
        () => new Date(),
        h.runtimeRepository,
      );

    // The runtime is currently unowned (ignite released its lease). Manually
    // claim it as one owner, then a second runner must observe ownership and
    // return waiting without mutating.
    const held = await h.runtimeRepository.claim(mission.id, "owner-A", 5 * 60_000);
    expect(held).toBe(true);

    const loser = await makeRunner().run(mission.id);
    expect(loser.state).toBe("waiting");
    expect(loser.reason).toBe("AUTONOMY_RUNTIME_ALREADY_OWNED");

    // Stale owner-A cannot save owned state after ownership is transferred.
    await h.runtimeRepository.release(mission.id, "owner-A");
    const heldB = await h.runtimeRepository.claim(mission.id, "owner-B", 5 * 60_000);
    expect(heldB).toBe(true);
    const staleRt = await h.runtimeRepository.get(mission.id);
    await expect(
      h.runtimeRepository.saveOwned({ ...staleRt!, cycleCount: 999 }, "owner-A"),
    ).rejects.toThrow("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");
  });

  it("SCENARIO 7 — REVIEWER FAILURE: reviewer unavailable → mission MUST NOT succeed", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    const throwing = new (class {
      async review(): Promise<never> {
        throw new Error("REVIEWER_UNAVAILABLE");
      }
    })();
    const dispatcher = new ScriptedWorkerDispatcher();
    const h = createHarness({ planner, reviewer: throwing, dispatcher });

    const mission = await h.ignite({ title: "No reviewer", objective: "Must not fake success" });
    const taskId = await firstTaskId(h, mission.id);

    // Worker completes, but the review fails closed: recordMissionTaskExecution
    // must propagate the failure (no ACCEPT, no succeeded).
    await expect(h.completeWorker({ workflowId: `icos-task-${taskId}` })).rejects.toThrow();

    const mission2 = await h.missions.findById(mission.id);
    expect(mission2?.status).not.toBe("succeeded");

    // The task is parked in review_pending (durable), never succeeded.
    const tasks = await h.listTasks(mission.id);
    expect(tasks[0].status).toBe("review_pending");
    // No review decision was persisted.
    expect(await h.reviewDecisions.getByWorkflowId(`icos-task-${taskId}`)).toBeNull();
  });

  it("SCENARIO 7b — MALFORMED REVIEWER OUTPUT: fails closed, mission not succeeded", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    // taskId not known until planning; use a reviewer that returns a
    // structurally invalid record (empty reasons) → normalization fails.
    const malformed = new (class {
      async review(input: import("@/server/review/ports").ReviewInput) {
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision: "APPROVE" as const,
          reviewerKind: "llm" as const,
          severity: "info" as const,
          reasons: [] as string[],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();
    const h = createHarness({ planner, reviewer: malformed });
    const mission = await h.ignite({ title: "Malformed", objective: "Reject malformed review" });
    const taskId = await firstTaskId(h, mission.id);

    await expect(h.completeWorker({ workflowId: `icos-task-${taskId}` })).rejects.toThrow();
    const m = await h.missions.findById(mission.id);
    expect(m?.status).not.toBe("succeeded");
  });

  it("SCENARIO 8 — DISPATCH AMBIGUITY: uncertain ack recovers via deterministic identity, no uncontrolled duplicate", async () => {
    const planner = new FixedPlanPlanner([singleTaskPlan()]);
    const approving = new (class {
      async review(input: import("@/server/review/ports").ReviewInput) {
        return {
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          decision: "APPROVE" as const,
          reviewerKind: "llm" as const,
          severity: "info" as const,
          reasons: ["APPROVE"],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        };
      }
    })();

    // The first external dispatch "succeeds" at the worker but the ack is
    // uncertain (transport dies): we model this as a dispatcher that throws on
    // the first call for the deterministic id, leaving the attempt PREPARED.
    const missions1 = createHarness({
      planner: new FixedPlanPlanner([singleTaskPlan()]),
      reviewer: approving,
      dispatcher: new ScriptedWorkerDispatcher(),
    });
    const mission = await missions1.missions.create({
      title: "Ambiguous",
      objective: "Recover an uncertain dispatch",
      tasks: [],
    });

    // Plan + prepare, but make the very first dispatch throw (ambiguous start).
    const taskIdHolder: { id?: string } = {};
    // Use a dispatcher that fails the first attempt then succeeds on recovery.
    const failing = new ScriptedWorkerDispatcher();
    const originalDispatch = failing.dispatch.bind(failing);
    let firstCall = true;
    failing.dispatch = async (input) => {
      if (firstCall) {
        firstCall = false;
        taskIdHolder.id = input.taskId;
        throw new Error("AMBIGUOUS_TRANSPORT_FAILURE");
      }
      return originalDispatch(input);
    };

    const h = createHarness({ planner, reviewer: approving, dispatcher: failing });
    // Ignition triggers planning + first dispatch, which throws; the runner
    // leaves a PREPARED attempt and surfaces the transport error.
    await expect(
      h.ignite({ title: "Ambiguous", objective: "Recover uncertain dispatch" }),
    ).rejects.toThrow("AMBIGUOUS_TRANSPORT_FAILURE");
    void mission;

    // A PREPARED (not dispatched) attempt exists with the deterministic id.
    const taskId = taskIdHolder.id!;
    const prepared = await h.dispatchAttempts.getByWorkflowId(`icos-task-${taskId}`);
    expect(prepared?.state).toBe("prepared");

    // Recovery reconciles the PREPARED dispatch using the SAME deterministic id.
    await h.supervisor.reconcilePreparedDispatches();
    const dispatchedIds = h.dispatcher.dispatches.map((d) => d.workflowId);
    expect(dispatchedIds.filter((id) => id === `icos-task-${taskId}`)).toHaveLength(1);
    const afterRecovery = await h.dispatchAttempts.getByWorkflowId(`icos-task-${taskId}`);
    expect(afterRecovery?.state).toBe("dispatched");
  });
});
