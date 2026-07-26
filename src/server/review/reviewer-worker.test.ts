import { describe, expect, it } from "vitest";

import { ReviewerWorker, CorrectionWorker } from "./reviewer-worker";
import type { ReviewSpec } from "@/core/review";

describe("ReviewerWorker", () => {
  function makeSpec(overrides?: Partial<ReviewSpec>): ReviewSpec {
    return {
      taskId: "task-001",
      missionId: "mission-001",
      tenantId: "tenant-001",
      objective: "Implémenter X",
      acceptanceCriteria: ["AC1", "AC2"],
      worktreePath: "/tmp/test-wt",
      requiredChecks: ["acceptance_criteria", "tests", "security_boundaries"],
      ...overrides,
    };
  }

  // ─────────────────────────────────
  // Independent review
  // ─────────────────────────────────

  describe("ensureIndependentReview", () => {
    it("denies same reviewer as implementer", async () => {
      const reviewer = new ReviewerWorker("worker-001");
      const result = await reviewer.ensureIndependentReview("worker-001", "worker-001");
      expect(result).toBe(false);
    });

    it("allows different reviewer and implementer", async () => {
      const reviewer = new ReviewerWorker("reviewer-001");
      const result = await reviewer.ensureIndependentReview("implementer-001", "reviewer-001");
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────
  // Review verdicts
  // ─────────────────────────────────

  describe("conductReview", () => {
    it("returns PASS for valid work", async () => {
      const reviewer = new ReviewerWorker();
      const result = await reviewer.conductReview(makeSpec());

      expect(result.verdict).toBe("PASS");
      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.completedAt).toBeDefined();
    });

    it("returns CHANGES_REQUIRED when acceptance criteria are missing", async () => {
      const reviewer = new ReviewerWorker();
      const result = await reviewer.conductReview(makeSpec({
        acceptanceCriteria: [],
      }));

      expect(result.verdict).toBe("CHANGES_REQUIRED");
      expect(result.checks.some((c) => !c.passed)).toBe(true);
    });

    it("reports duration", async () => {
      const reviewer = new ReviewerWorker();
      const result = await reviewer.conductReview(makeSpec());

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("CorrectionWorker", () => {
  describe("executeCorrection", () => {
    it("returns CORRECTED", async () => {
      const worker = new CorrectionWorker();
      const result = await worker.executeCorrection({
        originalTaskId: "task-001",
        missionId: "mission-001",
        reviewId: "review-001",
        reviewVerdict: "CHANGES_REQUIRED",
        reviewComments: "Fix tests",
        failedChecks: [],
        attemptNumber: 1,
        maxAttempts: 3,
        worktreePath: "/tmp/wt",
      });

      expect(result.outcome).toBe("CORRECTED");
    });
  });

  describe("isMaxAttemptsReached", () => {
    it("returns true when attempts equal max", () => {
      const worker = new CorrectionWorker();
      const spec = {
        originalTaskId: "task-001",
        missionId: "mission-001",
        reviewId: "review-001",
        reviewVerdict: "CHANGES_REQUIRED" as const,
        reviewComments: "",
        failedChecks: [],
        attemptNumber: 3,
        maxAttempts: 3,
        worktreePath: "/tmp/wt",
      };

      expect(worker.isMaxAttemptsReached(spec)).toBe(true);
    });

    it("returns false when below max", () => {
      const worker = new CorrectionWorker();
      const spec = {
        originalTaskId: "task-001",
        missionId: "mission-001",
        reviewId: "review-001",
        reviewVerdict: "CHANGES_REQUIRED" as const,
        reviewComments: "",
        failedChecks: [],
        attemptNumber: 1,
        maxAttempts: 3,
        worktreePath: "/tmp/wt",
      };

      expect(worker.isMaxAttemptsReached(spec)).toBe(false);
    });
  });
});
