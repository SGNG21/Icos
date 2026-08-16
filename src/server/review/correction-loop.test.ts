import { describe, expect, it } from "vitest";

import type { ReviewSpec, ReviewResult, CorrectionSpec, CorrectionResult } from "@/core/review";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "./ports";
import { CorrectionLoop } from "./correction-loop";

// ─────────────────────────────────────
// Fakes
// ─────────────────────────────────────

class FakeReviewerPass implements ReviewerManagerPort {
  async conductReview(_spec: ReviewSpec): Promise<ReviewResult> {
    return {
      verdict: "PASS",
      checks: [
        { category: "acceptance_criteria", description: "AC met", passed: true },
        { category: "tests", description: "Tests passent", passed: true },
        { category: "security_boundaries", description: "Sécurité OK", passed: true },
      ],
      summary: "Review PASS",
      confidence: 4,
      durationMs: 100,
      completedAt: new Date().toISOString(),
    };
  }
  async ensureIndependentReview(_taskId: string, _reviewerWorkerId: string): Promise<boolean> {
    return true;
  }
}

class FakeReviewerFail implements ReviewerManagerPort {
  private callCount = 0;

  async conductReview(_spec: ReviewSpec): Promise<ReviewResult> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        verdict: "CHANGES_REQUIRED",
        checks: [
          { category: "tests", description: "Tests manquants", passed: false },
          { category: "acceptance_criteria", description: "AC non respectée", passed: false },
        ],
        summary: "Review CHANGES_REQUIRED",
        comments: "Ajoutez des tests et corrigez l'AC",
        confidence: 2,
        durationMs: 150,
        completedAt: new Date().toISOString(),
      };
    }
    return {
      verdict: "PASS",
      checks: [
        { category: "tests", description: "Tests ajoutés", passed: true },
        { category: "acceptance_criteria", description: "AC respectée", passed: true },
      ],
      summary: "Review PASS après correction",
      confidence: 5,
      durationMs: 80,
      completedAt: new Date().toISOString(),
    };
  }
  async ensureIndependentReview(_taskId: string, _reviewerWorkerId: string): Promise<boolean> {
    return true;
  }
}

class FakeReviewerAlwaysFails implements ReviewerManagerPort {
  async conductReview(_spec: ReviewSpec): Promise<ReviewResult> {
    return {
      verdict: "CHANGES_REQUIRED",
      checks: [{ category: "tests", description: "Toujours échoué", passed: false }],
      summary: "Toujours CHANGES_REQUIRED",
      confidence: 1,
      durationMs: 50,
      completedAt: new Date().toISOString(),
    };
  }
  async ensureIndependentReview(_taskId: string, _reviewerWorkerId: string): Promise<boolean> {
    return true;
  }
}

class FakeCorrector implements CorrectionLoopManagerPort {
  private failAfter = Infinity;

  setFailAfter(n: number) {
    this.failAfter = n;
  }

  async executeCorrection(spec: CorrectionSpec): Promise<CorrectionResult> {
    if (spec.attemptNumber >= this.failAfter) {
      return { outcome: "FAILED", summary: "Échec de correction", durationMs: 5 };
    }
    return {
      outcome: "CORRECTED",
      summary: "Correction appliquée",
      commitSha: "abc123",
      durationMs: 10,
    };
  }

  isMaxAttemptsReached(spec: CorrectionSpec): boolean {
    return spec.attemptNumber >= spec.maxAttempts;
  }

  async escalate(_spec: CorrectionSpec): Promise<void> {
    // No-op dans les tests
  }
}

// ─────────────────────────────────────
// Tests
// ─────────────────────────────────────

describe("CorrectionLoop", () => {
  // ─────────────────────────────────
  // PASS direct
  // ─────────────────────────────────

  describe("when initial review passes", () => {
    it("returns PASS without corrections", async () => {
      const loop = new CorrectionLoop(new FakeReviewerPass(), new FakeCorrector());

      const result = await loop.execute(makeReviewSpec("task-001"), "/tmp/worktree");

      expect(result.finalVerdict).toBe("PASS");
      expect(result.attemptsUsed).toBe(0);
      expect(result.corrections).toHaveLength(0);
      expect(result.reviews).toHaveLength(1);
    });
  });

  // ─────────────────────────────────
  // Correction puis PASS
  // ─────────────────────────────────

  describe("when correction is needed", () => {
    it("applies corrections and re-reviews until PASS", async () => {
      const loop = new CorrectionLoop(new FakeReviewerFail(), new FakeCorrector());

      const result = await loop.execute(makeReviewSpec("task-001"), "/tmp/worktree");

      expect(result.finalVerdict).toBe("PASS");
      expect(result.attemptsUsed).toBe(1);
      expect(result.corrections).toHaveLength(1);
      expect(result.reviews).toHaveLength(2); // initial + re-review
    });
  });

  // ─────────────────────────────────
  // Escalade après épuisement
  // ─────────────────────────────────

  describe("when max attempts exceeded", () => {
    it("escalates after exhausting retries", async () => {
      const loop = new CorrectionLoop(new FakeReviewerAlwaysFails(), new FakeCorrector(), {
        maxAttempts: 2,
      });

      const result = await loop.execute(makeReviewSpec("task-001"), "/tmp/worktree");

      expect(result.finalVerdict).toBe("ESCALATED");
      expect(result.attemptsUsed).toBe(2);
      expect(result.corrections).toHaveLength(2);
      // 1 initial + 2 re-reviews = 3
      expect(result.reviews.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─────────────────────────────────
  // Correction échouée
  // ─────────────────────────────────

  describe("when correction itself fails", () => {
    it("reports FAILED without further retries", async () => {
      const corrector = new FakeCorrector();
      corrector.setFailAfter(1); // First correction fails

      const loop = new CorrectionLoop(new FakeReviewerFail(), corrector);

      const result = await loop.execute(makeReviewSpec("task-001"), "/tmp/worktree");

      expect(result.finalVerdict).toBe("FAILED");
      expect(result.corrections[0].outcome).toBe("FAILED");
    });
  });
});

// ─────────────────────────────────────
// Helpers
// ─────────────────────────────────────

function makeReviewSpec(taskId: string): ReviewSpec {
  return {
    taskId,
    missionId: "mission-001",
    tenantId: "tenant-001",
    objective: "Implémenter la fonctionnalité X",
    acceptanceCriteria: ["Les tests passent", "Le code est documenté"],
    requiredChecks: ["acceptance_criteria", "tests", "security_boundaries"],
    worktreePath: "/tmp/worktree",
  };
}
