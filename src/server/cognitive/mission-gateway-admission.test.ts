import { describe, expect, it, vi } from "vitest";

import { CanonicalGoalLauncher } from "./mission-gateway";

const proposal = {
  id: "p-1",
  title: "Trouve-moi des clients",
  objective: "prospect",
  constraints: [],
  successCriteria: [],
  riskLevel: "reversible" as const,
};

const request = {
  refId: "ref-1",
  conversationId: "c-1",
  turnId: "t-1",
  approvedBy: "geoffrey",
  clientId: null,
  projectId: null,
};

const launcher = (coordinator?: unknown) => {
  const enqueue = vi.fn(async () => ({ job: { id: "j", missionId: "m" }, created: true }));
  const goal = {
    id: "g-1",
    title: proposal.title,
    objective: proposal.objective,
    rawInput: proposal.objective,
    normalizedIntent: proposal.objective,
    constraints: [],
    successCriteria: [],
    priority: 3,
    riskLevel: "reversible",
    allowedCapabilities: [],
    forbiddenCapabilities: [],
    humanApprovalPolicy: "always",
    metadata: {
      source: "cognitive_conversation",
      conversationId: "c-1",
      turnId: "t-1",
      proposalRefId: "ref-1",
      approvedBy: "geoffrey",
    },
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  return {
    enqueue,
    instance: new CanonicalGoalLauncher({
      goalNormalizer: { normalize: () => goal } as never,
      goalPlanner: {
        plan: () => ({ goalId: "g-1", missionTitle: "t", missionObjective: "o", tasks: [] }),
      } as never,
      goalPreviewStore: { store: vi.fn(async () => undefined) } as never,
      goalRepository: { getById: vi.fn(async () => null) } as never,
      scheduler: { enqueue } as never,
      objectiveCoordinator: coordinator as never,
    }),
  };
};

describe("CanonicalGoalLauncher admission", () => {
  it("routes the launch through the coordinator when one is composed", async () => {
    const admit = vi.fn(async () => ({
      outcome: "enqueued" as const,
      jobId: "j",
      missionId: "m",
      created: true,
      priority: 92,
      evidence: { priority: {}, allocation: {} },
    }));
    const { enqueue, instance } = launcher({ admit });

    const r = await instance.launch(proposal as never, request);

    expect(admit).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "launched", missionId: "m" });
  });

  it("reports a deferred launch as launched, because the job is durable", async () => {
    const admit = vi.fn(async () => ({
      outcome: "deferred" as const,
      jobId: "j",
      missionId: "m",
      created: true,
      priority: 5,
      retryAfterMs: 300_000,
      reason: "CLASS_CONCURRENCY" as const,
      evidence: { priority: {}, allocation: {} },
    }));
    const { instance } = launcher({ admit });

    const r = await instance.launch(proposal as never, request);
    expect(r).toMatchObject({ status: "launched", missionId: "m" });
  });

  it("falls back to the plain enqueue when no coordinator is composed", async () => {
    const { enqueue, instance } = launcher(undefined);
    const r = await instance.launch(proposal as never, request);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "launched" });
  });
});
