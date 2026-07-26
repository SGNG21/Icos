import type {
  ReviewSpec,
  ReviewResult,
  ReviewCheck,
  CorrectionSpec,
  CorrectionResult,
} from "@/core/review";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "./ports";

// ─────────────────────────────────────
// Configuration
// ─────────────────────────────────────

export interface CorrectionLoopConfig {
  /** Nombre maximum de tentatives de correction avant escalade. */
  maxAttempts: number;
}

const DEFAULT_CONFIG: CorrectionLoopConfig = {
  maxAttempts: 3,
};

// ─────────────────────────────────────
// CorrectionLoop
// ─────────────────────────────────────

/**
 * Résultat complet d'une boucle de correction.
 */
export interface CorrectionLoopResult {
  /** Verdict final après la boucle. */
  finalVerdict: "PASS" | "ESCALATED" | "FAILED";
  /** Nombre total de tentatives. */
  attemptsUsed: number;
  /** Résultats de toutes les revues. */
  reviews: ReviewResult[];
  /** Résultats de toutes les corrections. */
  corrections: CorrectionResult[];
  /** Résumé final. */
  summary: string;
}

/**
 * Orchestre la boucle revue → correction → re-revue.
 *
 * Garantit :
 * - Revue indépendante (implémenteur ≠ reviewer)
 * - Boucle bornée (maxAttempts)
 * - Escalade après épuisement
 * - Pas de correction sans revue préalable
 */
export class CorrectionLoop {
  private readonly config: CorrectionLoopConfig;

  constructor(
    private readonly reviewer: ReviewerManagerPort,
    private readonly corrector: CorrectionLoopManagerPort,
    config?: Partial<CorrectionLoopConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Exécute la boucle complète : revue initiale → corrections → re-revues.
   *
   * @param reviewSpec - Spécification de la revue initiale
   * @param correctionWorktreePath - Chemin du worktree contenant le code
   * @returns Résultat final de la boucle
   */
  async execute(
    reviewSpec: ReviewSpec,
    correctionWorktreePath: string,
  ): Promise<CorrectionLoopResult> {
    const reviews: ReviewResult[] = [];
    const corrections: CorrectionResult[] = [];

    // Revue initiale
    const initialReview = await this.reviewer.conductReview(reviewSpec);
    reviews.push(initialReview);

    if (initialReview.verdict === "PASS") {
      return {
        finalVerdict: "PASS",
        attemptsUsed: 0,
        reviews,
        corrections,
        summary: "Revue initiale PASS — aucune correction nécessaire",
      };
    }

    // Boucle corrections
    let attempts = 0;
    let currentReview = initialReview;

    while (
      currentReview.verdict !== "PASS" &&
      attempts < this.config.maxAttempts
    ) {
      attempts++;

      // Créer la spécification de correction
      const correctionSpec: CorrectionSpec = {
        originalTaskId: reviewSpec.taskId,
        missionId: reviewSpec.missionId,
        reviewId: `review-${reviewSpec.taskId}-${attempts}`,
        reviewVerdict: currentReview.verdict === "FAILED" ? "FAILED" : "CHANGES_REQUIRED",
        reviewComments: currentReview.summary + (currentReview.comments ? `\n${currentReview.comments}` : ""),
        failedChecks: currentReview.checks.filter((c) => !c.passed),
        attemptNumber: attempts,
        maxAttempts: this.config.maxAttempts,
        worktreePath: correctionWorktreePath,
      };

      // Exécuter la correction
      const correction = await this.corrector.executeCorrection(correctionSpec);
      corrections.push(correction);

      if (correction.outcome !== "CORRECTED") {
        // La correction a échoué
        return {
          finalVerdict: "FAILED",
          attemptsUsed: attempts,
          reviews,
          corrections,
          summary: `Correction échouée à la tentative ${attempts}: ${correction.errorMessage ?? correction.summary}`,
        };
      }

      // Re-revue
      const reReviewSpec: ReviewSpec = {
        ...reviewSpec,
        worktreePath: correctionWorktreePath,
      };

      currentReview = await this.reviewer.conductReview(reReviewSpec);
      reviews.push(currentReview);
    }

    // Vérifier le résultat final
    if (currentReview.verdict === "PASS") {
      return {
        finalVerdict: "PASS",
        attemptsUsed: attempts,
        reviews,
        corrections,
        summary: `Corrections acceptées après ${attempts} tentative(s)`,
      };
    }

    // Escalade
    const lastSpec: CorrectionSpec = {
      originalTaskId: reviewSpec.taskId,
      missionId: reviewSpec.missionId,
      reviewId: `review-${reviewSpec.taskId}-${attempts}`,
      reviewVerdict: "CHANGES_REQUIRED",
      reviewComments: currentReview.summary,
      failedChecks: currentReview.checks.filter((c) => !c.passed),
      attemptNumber: attempts,
      maxAttempts: this.config.maxAttempts,
      worktreePath: correctionWorktreePath,
    };

    await this.corrector.escalate(lastSpec);

    return {
      finalVerdict: "ESCALATED",
      attemptsUsed: attempts,
      reviews,
      corrections,
      summary: `Escalade après ${attempts} tentative(s) de correction épuisées`,
    };
  }
}
