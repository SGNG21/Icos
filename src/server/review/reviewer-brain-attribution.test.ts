import { describe, expect, it } from "vitest";

import type { Attribution } from "@/core/budget/contracts";
import { currentAttribution } from "@/server/budget/attribution-context";

import type { DeterministicReviewer } from "./deterministic-reviewer";
import type { ReviewInput, ReviewerPort } from "./ports";
import { ReviewerServiceImpl } from "./reviewer-service";

/**
 * Decision 0070: the LLM review is attributed to the mission's Reviewer brain, so the spend
 * ledger carries `brain_id = brain-reviewer` for every review — the durable proof that the
 * reviewer brain is load-bearing. A mission that was never delegated reviews as before.
 */
function service(
  reviewAssignment?: (
    missionId: string,
  ) => Promise<{ assignmentId: string; agentId: string } | null>,
) {
  const seen: (Attribution | null)[] = [];
  const llm: ReviewerPort = {
    review: async () => {
      seen.push(currentAttribution());
      return {
        decision: "APPROVE",
        reasons: ["ok"],
        providerMetadata: { provider: "p", model: "m" },
      };
    },
  };
  const deterministic = {
    apply: () => ({ blockingDecision: null, hardReasons: [], proceedToLlm: true }),
  } as unknown as DeterministicReviewer;
  const saved: unknown[] = [];
  const repo = { save: async (d: unknown) => (saved.push(d), d) } as never;
  return {
    impl: new ReviewerServiceImpl(llm, deterministic, repo, reviewAssignment),
    seen,
    saved,
  };
}

const input = (goalId?: string) =>
  ({
    mission: { id: "m-1", goalId },
    missionTask: { id: "mt-1" },
    task: { id: "task-1", title: "t", description: undefined },
    executionResult: { taskId: "task-1", workflowId: "w-1" },
    artifacts: [],
    evidence: [],
    findings: [],
  }) as unknown as ReviewInput;

describe("reviewer brain attribution", () => {
  it("records the Reviewer brain Chief assigned ON THE DECISION, and in the review's scope", async () => {
    const s = service(async (missionId) =>
      missionId === "m-1" ? { assignmentId: "wfa-r", agentId: "brain-reviewer" } : null,
    );
    await s.impl.review(input("g-1"));
    expect(s.seen[0]).toEqual({ goalId: "g-1", brainId: "brain-reviewer" });
    expect(s.saved[0]).toMatchObject({
      providerMetadata: {
        provider: "p",
        model: "m",
        routing: { workforce: { assignmentId: "wfa-r", agentId: "brain-reviewer" } },
      },
    });
  });

  it("an undelegated mission, or a failing lookup, reviews exactly as before", async () => {
    const none = service(async () => null);
    await none.impl.review(input("g-1"));
    expect(none.seen[0]).toEqual({ goalId: "g-1" });
    const failing = service(async () => {
      throw new Error("workforce down");
    });
    await failing.impl.review(input());
    expect(failing.seen[0]).toEqual({ systemReviewMissionId: "m-1" });
  });
});
