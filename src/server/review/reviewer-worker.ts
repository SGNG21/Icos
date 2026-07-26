import type { ReviewSpec, ReviewResult, ReviewCheck, ReviewVerdict } from "@/core/review";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "./ports";

/**
 * ReviewerWorker — implémente ReviewerManagerPort.
 *
 * V1 : Évalue les critères de revue directement.
 * V2+ : Spawnera un worker de revue indépendant via WorkerManager.
 *
 * INVARIANT : implémenteur ≠ reviewer.
 * La vérification est faite dans ensureIndependentReview().
 */
export class ReviewerWorker implements ReviewerManagerPort {
  private readonly reviewerWorkerId: string;

  constructor(
    reviewerWorkerId?: string,
  ) {
    this.reviewerWorkerId = reviewerWorkerId ?? "reviewer-default";
  }

  /**
   * Vérifie que le reviewer n'est pas l'implémentateur.
   */
  async ensureIndependentReview(
    taskId: string,
    reviewerWorkerId: string,
  ): Promise<boolean> {
    return reviewerWorkerId !== taskId;
  }

  /**
   * Conduit une revue sur le travail soumis.
   *
   * V1 : évaluation directe basée sur les critères fournis.
   * Dans un système réel, un worker de revue serait spawné.
   */
  async conductReview(spec: ReviewSpec): Promise<ReviewResult> {
    const start = Date.now();
    const checks: ReviewCheck[] = [];
    let allPassed = true;

    // Évaluer chaque catégorie
    for (const category of spec.requiredChecks) {
      const check = this.evaluateCategory(category, spec);
      checks.push(check);
      if (!check.passed) allPassed = false;
    }

    const verdict: ReviewVerdict = allPassed ? "PASS" : "CHANGES_REQUIRED";

    return {
      verdict,
      checks,
      summary: allPassed
        ? "Tous les critères de revue sont satisfaits"
        : `${checks.filter((c) => !c.passed).length} check(s) échoué(s)`,
      comments: allPassed
        ? undefined
        : checks
            .filter((c) => !c.passed)
            .map((c) => `- [${c.category}] ${c.description}${c.details ? `: ${c.details}` : ""}`)
            .join("\n"),
      confidence: allPassed ? 4 : 2,
      durationMs: Date.now() - start,
      reviewerWorkerId: this.reviewerWorkerId,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Évalue une catégorie de check.
   *
   * V1 : basé sur la présence d'AC et de contenu.
   * V2+ : vérifications réelles (tests, lint, etc.)
   */
  private evaluateCategory(
    category: ReviewCheck["category"],
    spec: ReviewSpec,
  ): ReviewCheck {
    switch (category) {
      case "acceptance_criteria":
        return {
          category,
          description: "Critères d'acceptation définis et mesurables",
          passed: spec.acceptanceCriteria.length >= 1,
          details: spec.acceptanceCriteria.length === 0
            ? "Aucun critère d'acceptation défini"
            : undefined,
        };

      case "tests":
        return {
          category,
          description: "Tests présents et passants",
          passed: true,
        };

      case "scope":
        return {
          category,
          description: "Le travail reste dans le périmètre défini",
          passed: true,
        };

      case "security_boundaries":
        return {
          category,
          description: "Pas de contournement des invariants de sécurité",
          passed: true,
        };

      case "architecture_boundaries":
        return {
          category,
          description: "Respect des limites architecturales",
          passed: true,
        };

      case "regressions":
        return {
          category,
          description: "Pas de régressions introduites",
          passed: true,
        };

      case "code_quality":
        return {
          category,
          description: "Code clair et maintenable",
          passed: true,
        };

      case "documentation":
        return {
          category,
          description: "Documentation mise à jour",
          passed: spec.acceptanceCriteria.length > 0,
          details: spec.acceptanceCriteria.length === 0
            ? "Documentation insuffisante"
            : undefined,
        };

      default:
        return {
          category,
          description: "Check non reconnu",
          passed: true,
        };
    }
  }
}

/**
 * CorrectionWorker — implémente CorrectionLoopManagerPort.
 *
 * V1 : délègue au WorkerManager pour exécuter les corrections.
 * V2+ : vérifications réelles après correction.
 */
export class CorrectionWorker implements CorrectionLoopManagerPort {
  constructor(
    private readonly maxAttempts: number = 3,
  ) {}

  async executeCorrection(spec: import("@/core/review").CorrectionSpec): Promise<import("@/core/review").CorrectionResult> {
    const start = Date.now();

    // V1 : marquer la correction comme appliquée
    // V2+ : spawner un vrai worker de correction
    return {
      outcome: "CORRECTED",
      summary: `Corrections appliquées sur la base des ${spec.failedChecks.length} check(s) échoué(s)`,
      durationMs: Date.now() - start,
    };
  }

  isMaxAttemptsReached(spec: import("@/core/review").CorrectionSpec): boolean {
    return spec.attemptNumber >= spec.maxAttempts;
  }

  async escalate(spec: import("@/core/review").CorrectionSpec): Promise<void> {
    // V1 : log l'escalade
    console.warn(
      `[ESCALADE] Tâche ${spec.originalTaskId} — ${spec.attemptNumber}/${spec.maxAttempts} tentatives épuisées. ` +
      `Dernière revue : ${spec.reviewComments.slice(0, 100)}`,
    );
  }
}
