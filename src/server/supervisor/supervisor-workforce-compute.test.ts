import { describe, expect, it, vi } from "vitest";

import { buildMemoryContainer } from "@/server/container";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import type { CapabilityRouter, ComputeRequest } from "@/server/routing/capability-router";
import type { WorkerRequirement } from "@/core/workers/worker-eligibility";
import type { BrainComputeNeed, WorkforceTaskCompute } from "@/server/workforce/core3-task-compute";

import { SupervisorService } from "./supervisor-service";

/**
 * What a BRAIN ASSIGNMENT does to a CORE3 dispatch (decisions 0057 §integration, 0066).
 *
 * The compute port's `requestFor` had no caller: twelve seeded brains would have been twelve
 * rows the dispatcher ignores. These are the proofs that it is now consulted at the one place
 * CORE3 turns a ready task into a routing requirement — and that it can only ever RAISE the
 * bar or HOLD the dispatch, never widen a requirement and never name a model.
 */

const need = (over: Partial<BrainComputeNeed> = {}): BrainComputeNeed => ({
  assignmentId: "wfa-1",
  agentId: "brain-builder",
  workerCapabilities: [],
  complexity: "low",
  approvalPending: false,
  ...over,
});

async function harness(brain: BrainComputeNeed | null) {
  const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
  const mission = await container.mission.create({
    title: "brain wiring",
    objective: "route one ready task",
    tasks: [{ title: "A", description: "A", dependsOn: [], workerKind: "agent" }],
  });
  const seen: { requirement: WorkerRequirement; compute?: ComputeRequest }[] = [];
  const router = {
    route: async (requirement: WorkerRequirement, compute?: ComputeRequest) => {
      seen.push({ requirement, compute });
      // ROUTING_UNCONFIGURED: the pre-M4 path, so dispatch proceeds and the requirement the
      // router was HANDED is what this test is about.
      return {
        decision: "ROUTING_UNCONFIGURED" as const,
        worker: null,
        requirement,
        candidates: [],
        reason: "test",
      };
    },
  } as unknown as CapabilityRouter;
  const forTask = vi.fn(async () => brain);
  const workforce: WorkforceTaskCompute = { forTask };
  const dispatch = vi.fn(async ({ taskId }: { taskId: string }) => ({ workflowId: `w-${taskId}` }));
  const supervisor = new SupervisorService(
    container.mission,
    container.tasks,
    { dispatch } as unknown as TaskExecutionDispatcher,
    container.durableMemory,
    undefined,
    undefined,
    router,
    undefined,
    workforce,
  );
  return { container, mission, supervisor, seen, dispatch, forTask };
}

describe("SupervisorService × the workforce compute port", () => {
  it("asks the brain assignment for this mission task, and takes the STRICTER difficulty", async () => {
    const h = await harness(need({ complexity: "high", workerCapabilities: ["appsec"] }));
    await h.supervisor.run(h.mission.id);

    const task = (await h.container.mission.listTasks(h.mission.id))[0];
    expect(h.forTask).toHaveBeenCalledWith(h.mission.id, task.taskId);
    // `reversible` (the canonical Task's default risk) alone would route as `medium`.
    expect(h.seen[0].compute?.complexity).toBe("high");
    expect(h.seen[0].requirement.requiredCapabilities).toContain("appsec");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await h.container.close();
  });

  it("never lets a brain LOWER the bar: a low-difficulty brain keeps the task's own", async () => {
    const h = await harness(need({ complexity: "low" }));
    await h.supervisor.run(h.mission.id);
    expect(h.seen[0].compute?.complexity).toBe("medium");
    await h.container.close();
  });

  it("holds the dispatch while a required human approval is missing, without blocking the task", async () => {
    const h = await harness(need({ approvalPending: true }));
    await h.supervisor.run(h.mission.id);

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.seen).toEqual([]);
    // Deferred, never `blocked`: a human approving ends the hold by itself.
    const task = (await h.container.mission.listTasks(h.mission.id))[0];
    expect(task.status).not.toBe("blocked");
    await h.container.close();
  });

  it("routes exactly as before when no brain assignment waits for the task", async () => {
    const h = await harness(null);
    await h.supervisor.run(h.mission.id);
    expect(h.seen[0].compute?.complexity).toBe("medium");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await h.container.close();
  });
});
