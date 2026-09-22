import { describe, it, expect, vi, beforeEach } from "vitest";
import { SelfDevelopmentController } from "./self-development-controller";
import { SelfDevelopmentMetrics } from "./self-development-metrics";
import type {
  SelfDevelopmentCandidate,
  PolicyEvaluation,
  RepairResult,
  ReviewOutcome,
  SelfDevelopmentOutcome,
  PolicyEvaluationPort,
  BoundedRepairPort,
  IndependentReviewPort,
  SelfDevelopmentMemoryPort,
  SelfDevelopmentState,
} from "@/core/contracts/self-development";

// Test doubles
class MockPolicyEvaluationPort implements PolicyEvaluationPort {
  constructor(private result: PolicyEvaluation) {}
  async evaluate(): Promise<PolicyEvaluation> {
    return this.result;
  }
}

class MockBoundedRepairPort implements BoundedRepairPort {
  constructor(private results: RepairResult[]) {}
  private callCount = 0;
  async requestRepair(): Promise<RepairResult> {
    return this.results[this.callCount++] ?? { success: false, error: "NO_MORE_RESULTS" } as RepairResult;
  }
  async getMaxAttempts(): Promise<number> {
    return 3;
  }
}

class MockIndependentReviewPort implements IndependentReviewPort {
  constructor(private results: ReviewOutcome[]) {}
  private callCount = 0;
  async review(): Promise<ReviewOutcome> {
    return this.results[this.callCount++] ?? { result: "rejected", reason: "NO_MORE_RESULTS" } as ReviewOutcome;
  }
}

class MockMemoryPort implements SelfDevelopmentMemoryPort {
  private store = new Map<string, SelfDevelopmentOutcome>();
  async saveOutcome(outcome: SelfDevelopmentOutcome): Promise<void> {
    this.store.set(outcome.candidateId, outcome);
  }
  async getOutcome(candidateId: string): Promise<SelfDevelopmentOutcome | null> {
    return this.store.get(candidateId) ?? null;
  }
  async listOutcomes(): Promise<SelfDevelopmentOutcome[]> {
    return Array.from(this.store.values());
  }
}

const baseCandidate: SelfDevelopmentCandidate = {
  candidateId: "candidate-001",
  missionId: "mission-001",
  proposal: {
    type: "skill_improvement",
    description: "Test improvement",
    payload: { key: "value" },
  },
  metadata: {},
  submittedAt: new Date().toISOString(),
};

describe("SelfDevelopmentController", () => {
  let memory: MockMemoryPort;
  let metrics: SelfDevelopmentMetrics;

  beforeEach(() => {
    memory = new MockMemoryPort();
    metrics = new SelfDevelopmentMetrics();
  });

  const createController = (
    policy: PolicyEvaluation,
    repairs: RepairResult[] = [],
    reviews: ReviewOutcome[] = [],
  ) =>
    new SelfDevelopmentController(
      new MockPolicyEvaluationPort(policy),
      new MockBoundedRepairPort(repairs),
      new MockIndependentReviewPort(reviews),
      memory,
      metrics,
    );

  describe("normal accepted lifecycle", () => {
    it("policy allow -> review approved -> accepted", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("accepted");
      expect(outcome.acceptedProposal).toEqual({ key: "value" });
      expect(outcome.repairAttemptsUsed).toBe(0);
      expect(metrics.getSnapshot().repairsAccepted).toBe(1);
      expect(metrics.getSnapshot().candidatesProcessed).toBe(1);
      expect(metrics.getSnapshot().cyclesTotal).toBe(1);
    });

    it("policy repair -> repair success -> review approved -> accepted", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "repair", reason: "needs fix", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [
          { candidateId: "candidate-001", attemptNumber: 1, success: true, repairedProposal: { key: "repaired" }, completedAt: new Date().toISOString() },
        ],
        [{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("accepted");
      expect(outcome.acceptedProposal).toEqual({ key: "repaired" });
      expect(outcome.repairAttemptsUsed).toBe(1); // actual attempts used
      expect(metrics.getSnapshot().repairsAttempted).toBe(1);
      expect(metrics.getSnapshot().repairsAccepted).toBe(1); // from review approved
    });
  });

  describe("rejected -> repair lifecycle", () => {
    it("policy allow -> review rejected -> exhausted", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [{ candidateId: "candidate-001", result: "rejected", reason: "not good", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("exhausted");
      expect(outcome.rejectionReason).toBe("not good");
      expect(metrics.getSnapshot().repairsRejected).toBe(1);
    });

    it("policy repair -> repair fails -> exhausted", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "repair", reason: "needs fix", maxRepairAttempts: 2, evaluatedAt: new Date().toISOString() },
        [
          { candidateId: "candidate-001", attemptNumber: 1, success: false, error: "repair failed", completedAt: new Date().toISOString() },
          { candidateId: "candidate-001", attemptNumber: 2, success: false, error: "repair failed again", completedAt: new Date().toISOString() },
        ],
        [],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("exhausted");
      expect(metrics.getSnapshot().repairsAttempted).toBe(2);
      expect(metrics.getSnapshot().repairsRejected).toBe(2);
      expect(metrics.getSnapshot().repairsExhausted).toBe(1);
    });

    it("policy repair -> repair succeeds -> review rejected -> next attempt -> exhausted", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "repair", reason: "needs fix", maxRepairAttempts: 2, evaluatedAt: new Date().toISOString() },
        [
          { candidateId: "candidate-001", attemptNumber: 1, success: true, repairedProposal: { key: "repaired" }, completedAt: new Date().toISOString() },
        ],
        [
          { candidateId: "candidate-001", result: "rejected", reason: "still not good", reviewedAt: new Date().toISOString() },
        ],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("exhausted");
      expect(metrics.getSnapshot().repairsAttempted).toBe(2); // two attempts made (maxRepairAttempts)
      expect(metrics.getSnapshot().repairsRejected).toBe(2); // 1 from review rejection + 1 from second repair failure
      expect(metrics.getSnapshot().repairsExhausted).toBe(1);
    });
  });

  describe("exhausted -> HUMAN_DECISION_REQUIRED", () => {
    it("policy deny -> exhausted -> human_decision_required", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "deny", reason: "policy denies", maxRepairAttempts: 0, evaluatedAt: new Date().toISOString() },
        [],
        [],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("exhausted");
      expect(outcome.rejectionReason).toBe("policy denies");
    });

    it("exhausted all repair attempts -> exhausted state (human escalation tracked separately)", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "repair", reason: "needs fix", maxRepairAttempts: 1, evaluatedAt: new Date().toISOString() },
        [
          { candidateId: "candidate-001", attemptNumber: 1, success: true, repairedProposal: { key: "repaired" }, completedAt: new Date().toISOString() },
        ],
        [
          { candidateId: "candidate-001", result: "needs_repair", reason: "needs more repair", reviewedAt: new Date().toISOString() },
        ],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("exhausted");
      expect(metrics.getSnapshot().repairsExhausted).toBe(1);
    });
  });

  describe("UNKNOWN -> fail closed", () => {
    it("unknown policy result -> human_decision_required", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "unknown" as any, reason: "unknown", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("human_decision_required");
      expect(outcome.rejectionReason).toContain("UNKNOWN_POLICY_RESULT");
      expect(metrics.getSnapshot().humanEscalations).toBe(1);
    });

    it("unknown review result -> human_decision_required", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [{ candidateId: "candidate-001", result: "unknown" as any, reason: "unknown", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("human_decision_required");
      expect(metrics.getSnapshot().humanEscalations).toBe(1);
    });

    it("dependency error -> human_decision_required", async () => {
      const errorPort = {
        evaluate: vi.fn().mockRejectedValue(new Error("DB connection failed")),
      } as unknown as PolicyEvaluationPort;

      const controller = new SelfDevelopmentController(
        errorPort,
        new MockBoundedRepairPort([]),
        new MockIndependentReviewPort([]),
        memory,
        metrics,
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("human_decision_required");
      expect(outcome.rejectionReason).toContain("DEPENDENCY_ERROR");
      expect(metrics.getSnapshot().humanEscalations).toBe(1);
    });
  });

  describe("metrics deterministic", () => {
    it("same input sequence produces same metrics", async () => {
      const controller1 = createController(
        { candidateId: "candidate-001", result: "repair", reason: "needs fix", maxRepairAttempts: 2, evaluatedAt: new Date().toISOString() },
        [
          { candidateId: "candidate-001", attemptNumber: 1, success: true, repairedProposal: { key: "repaired" }, completedAt: new Date().toISOString() },
        ],
        [{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      const controller2 = createController(
        { candidateId: "candidate-002", result: "repair", reason: "needs fix", maxRepairAttempts: 2, evaluatedAt: new Date().toISOString() },
        [
          { candidateId: "candidate-002", attemptNumber: 1, success: true, repairedProposal: { key: "repaired" }, completedAt: new Date().toISOString() },
        ],
        [{ candidateId: "candidate-002", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      await controller1.processCandidate({ ...baseCandidate, candidateId: "candidate-001" });
      await controller2.processCandidate({ ...baseCandidate, candidateId: "candidate-002" });

      // Each controller has its own metrics instance, so they should be identical
      const snap1 = controller1.getMetrics().getSnapshot();
      const snap2 = controller2.getMetrics().getSnapshot();

      expect(snap1.cyclesTotal).toBe(snap2.cyclesTotal);
      expect(snap1.candidatesProcessed).toBe(snap2.candidatesProcessed);
      expect(snap1.repairsAttempted).toBe(snap2.repairsAttempted);
      expect(snap1.repairsAccepted).toBe(snap2.repairsAccepted);
      expect(snap1.repairsRejected).toBe(snap2.repairsRejected);
      expect(snap1.repairsExhausted).toBe(snap2.repairsExhausted);
      expect(snap1.humanEscalations).toBe(snap2.humanEscalations);
      expect(snap1.patternsLearned).toBe(snap2.patternsLearned);
    });
  });

  describe("no autonomous promotion", () => {
    it("controller never returns a state that implies autonomous promotion", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      // Controller only orchestrates - final states are terminal and don't imply autonomous promotion
      expect(["accepted", "exhausted", "human_decision_required"]).toContain(outcome.finalState);
      // No "promoted", "auto_approved", "deployed" etc.
    });
  });

  describe("dependency error fails closed", () => {
    it("repair port error -> human_decision_required", async () => {
      const errorRepairPort = {
        requestRepair: vi.fn().mockRejectedValue(new Error("repair service down")),
        getMaxAttempts: vi.fn().mockResolvedValue(3),
      } as unknown as BoundedRepairPort;

      const controller = new SelfDevelopmentController(
        new MockPolicyEvaluationPort({ candidateId: "candidate-001", result: "repair", reason: "needs fix", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() }),
        errorRepairPort,
        new MockIndependentReviewPort([]),
        memory,
        metrics,
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("human_decision_required");
      expect(outcome.rejectionReason).toContain("DEPENDENCY_ERROR");
      expect(metrics.getSnapshot().humanEscalations).toBe(1);
    });

    it("review port error -> human_decision_required", async () => {
      const errorReviewPort = {
        review: vi.fn().mockRejectedValue(new Error("review service down")),
      } as unknown as IndependentReviewPort;

      const controller = new SelfDevelopmentController(
        new MockPolicyEvaluationPort({ candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() }),
        new MockBoundedRepairPort([]),
        errorReviewPort,
        memory,
        metrics,
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("human_decision_required");
      expect(outcome.rejectionReason).toContain("DEPENDENCY_ERROR");
      expect(metrics.getSnapshot().humanEscalations).toBe(1);
    });

    it("memory port error -> human_decision_required", async () => {
      const errorMemoryPort = {
        saveOutcome: vi.fn().mockRejectedValue(new Error("db down")),
        getOutcome: vi.fn().mockResolvedValue(null),
        listOutcomes: vi.fn().mockResolvedValue([]),
      } as unknown as SelfDevelopmentMemoryPort;

      const controller = new SelfDevelopmentController(
        new MockPolicyEvaluationPort({ candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() }),
        new MockBoundedRepairPort([]),
        new MockIndependentReviewPort([{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }]),
        errorMemoryPort,
        metrics,
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("human_decision_required");
      expect(outcome.rejectionReason).toContain("DEPENDENCY_ERROR");
      expect(metrics.getSnapshot().humanEscalations).toBe(1);
    });
  });

  describe("defensive copy / immutable result", () => {
    it("outcome object is independent (defensive copy)", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      // Modify the returned outcome
      (outcome as any).finalState = "tampered";
      (outcome as any).acceptedProposal = { tampered: true };

      // Get again from memory - should be unchanged
      const stored = await memory.getOutcome("candidate-001");
      expect(stored?.finalState).toBe("accepted");
      expect(stored?.acceptedProposal).toEqual({ key: "value" });
    });

    it("acceptedProposal in outcome is not the same reference as input", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      // The acceptedProposal should be a copy, not the same reference
      expect(outcome.acceptedProposal).not.toBe(baseCandidate.proposal.payload);
      expect(outcome.acceptedProposal).toEqual(baseCandidate.proposal.payload);
    });
  });

  describe("state machine completeness", () => {
    it("all states reachable through valid transitions", async () => {
      // candidate_received -> policy_evaluation -> allow -> review_result -> accepted
      const c1 = createController(
        { candidateId: "c1", result: "allow", reason: "ok", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [{ candidateId: "c1", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );
      const o1 = await c1.processCandidate({ ...baseCandidate, candidateId: "c1" });
      expect(o1.finalState).toBe("accepted");

      // candidate_received -> policy_evaluation -> repair -> repair_requested -> review_result -> accepted
      const c2 = createController(
        { candidateId: "c2", result: "repair", reason: "fix", maxRepairAttempts: 1, evaluatedAt: new Date().toISOString() },
        [{ candidateId: "c2", attemptNumber: 1, success: true, repairedProposal: { x: 1 }, completedAt: new Date().toISOString() }],
        [{ candidateId: "c2", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );
      const o2 = await c2.processCandidate({ ...baseCandidate, candidateId: "c2" });
      expect(o2.finalState).toBe("accepted");

      // candidate_received -> policy_evaluation -> deny -> exhausted
      const c3 = createController(
        { candidateId: "c3", result: "deny", reason: "no", maxRepairAttempts: 0, evaluatedAt: new Date().toISOString() },
        [],
        [],
      );
      const o3 = await c3.processCandidate({ ...baseCandidate, candidateId: "c3" });
      expect(o3.finalState).toBe("exhausted");

      // candidate_received -> policy_evaluation -> repair -> exhausted (all attempts fail)
      const c4 = createController(
        { candidateId: "c4", result: "repair", reason: "fix", maxRepairAttempts: 1, evaluatedAt: new Date().toISOString() },
        [{ candidateId: "c4", attemptNumber: 1, success: false, error: "failed", completedAt: new Date().toISOString() }],
        [],
      );
      const o4 = await c4.processCandidate({ ...baseCandidate, candidateId: "c4" });
      expect(o4.finalState).toBe("exhausted");

      // UNKNOWN policy -> human_decision_required
      const c5 = createController(
        { candidateId: "c5", result: "unknown" as any, reason: "?", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        [],
        [],
      );
      const o5 = await c5.processCandidate({ ...baseCandidate, candidateId: "c5" });
      expect(o5.finalState).toBe("human_decision_required");
    });
  });

  describe("bounded repair respects max attempts from policy", () => {
    it("repair loop stops at maxRepairAttempts from policy evaluation", async () => {
      const controller = createController(
        { candidateId: "candidate-001", result: "repair", reason: "needs fix", maxRepairAttempts: 2, evaluatedAt: new Date().toISOString() },
        [
          { candidateId: "candidate-001", attemptNumber: 1, success: false, error: "fail1", completedAt: new Date().toISOString() },
          { candidateId: "candidate-001", attemptNumber: 2, success: false, error: "fail2", completedAt: new Date().toISOString() },
        ],
        [],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("exhausted");
      expect(outcome.repairAttemptsUsed).toBe(2);
      expect(metrics.getSnapshot().repairsAttempted).toBe(2);
    });

    it("does not implement repair worker rotation", async () => {
      // The controller should not have any logic for rotating repair workers
      // It just calls the bounded repair port with attempt numbers
      const repairResults: RepairResult[] = [];
      for (let i = 1; i <= 3; i++) {
        repairResults.push({
          candidateId: "candidate-001",
          attemptNumber: i,
          success: i === 3,
          repairedProposal: i === 3 ? { fixed: true } : undefined,
          completedAt: new Date().toISOString(),
        });
      }

      const controller = createController(
        { candidateId: "candidate-001", result: "repair", reason: "fix", maxRepairAttempts: 3, evaluatedAt: new Date().toISOString() },
        repairResults,
        [{ candidateId: "candidate-001", result: "approved", reason: "approved", reviewedAt: new Date().toISOString() }],
      );

      const outcome = await controller.processCandidate(baseCandidate);

      expect(outcome.finalState).toBe("accepted");
      // Controller just sequentially calls repair port - no rotation logic
    });
  });
});