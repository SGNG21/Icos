import type { ReviewSpec, ReviewResult, CorrectionSpec, CorrectionResult } from "@/core/review";

/**
 * Port du ReviewerManager.
 * Gère la création et exécution de revues indépendantes.
 */
export interface ReviewerManagerPort {
  /**
   * Lance une revue sur le travail d'un implémentateur.
   * Vérifie que le reviewer ≠ implémentateur.
   */
  conductReview(spec: ReviewSpec): Promise<ReviewResult>;

  /**
   * Vérifie qu'un reviewer potentiel n'est PAS l'implémentateur.
   */
  ensureIndependentReview(taskId: string, reviewerWorkerId: string): Promise<boolean>;
}

/**
 * Port du CorrectionLoopManager.
 * Gère la boucle corrections → re-revue.
 */
export interface CorrectionLoopManagerPort {
  /**
   * Lance une correction suite à une revue CHANGES_REQUIRED/FAILED.
   */
  executeCorrection(spec: CorrectionSpec): Promise<CorrectionResult>;

  /**
   * Vérifie si la limite de tentatives est atteinte.
   */
  isMaxAttemptsReached(spec: CorrectionSpec): boolean;

  /**
   * Escalade après épuisement des tentatives.
   */
  escalate(spec: CorrectionSpec): Promise<void>;
}
