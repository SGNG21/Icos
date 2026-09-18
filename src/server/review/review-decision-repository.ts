import type { ReviewDecisionRecord } from "@/core/contracts/review";

/**
 * Port pour la persistence des décisions de revue.
 */
export interface ReviewDecisionRepository {
  /** Enregistre une décision de revue */
  save(decision: ReviewDecisionRecord): Promise<ReviewDecisionRecord>;

  /** Récupère une décision par son ID */
  getById(id: string): Promise<ReviewDecisionRecord | null>;

  /** Récupère la décision pour un workflowId (idempotence) */
  getByWorkflowId(workflowId: string): Promise<ReviewDecisionRecord | null>;

  /** Récupère toutes les décisions pour une tâche */
  listByTaskId(taskId: string): Promise<ReviewDecisionRecord[]>;

  /** Récupère toutes les décisions pour une mission */
  listByMissionId(missionId: string): Promise<ReviewDecisionRecord[]>;

  /** Liste toutes les décisions (pour audit) */
  list(): Promise<ReviewDecisionRecord[]>;
}
