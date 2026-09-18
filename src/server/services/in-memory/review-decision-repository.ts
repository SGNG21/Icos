import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";

/**
 * Implémentation en mémoire du repository de décisions de revue.
 * Pour tests et développement.
 */
export class InMemoryReviewDecisionRepository implements ReviewDecisionRepository {
  private readonly decisions: Map<string, ReviewDecisionRecord> = new Map();
  private readonly byWorkflowId: Map<string, string> = new Map(); // workflowId -> decisionId

  async save(decision: ReviewDecisionRecord): Promise<ReviewDecisionRecord> {
    // Idempotence par workflowId
    const existingId = this.byWorkflowId.get(decision.workflowId);
    if (existingId) {
      const existing = this.decisions.get(existingId);
      if (existing) {
        // Retourner l'existant sans l'écraser (même comportement que TaskExecutionResult)
        return structuredClone(existing);
      }
    }

    const cloned = structuredClone(decision);
    this.decisions.set(cloned.id, cloned);
    this.byWorkflowId.set(cloned.workflowId, cloned.id);
    return cloned;
  }

  async getById(id: string): Promise<ReviewDecisionRecord | null> {
    const decision = this.decisions.get(id);
    return decision ? structuredClone(decision) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<ReviewDecisionRecord | null> {
    const decisionId = this.byWorkflowId.get(workflowId);
    if (!decisionId) return null;
    const decision = this.decisions.get(decisionId);
    return decision ? structuredClone(decision) : null;
  }

  async listByTaskId(taskId: string): Promise<ReviewDecisionRecord[]> {
    const results: ReviewDecisionRecord[] = [];
    for (const decision of this.decisions.values()) {
      if (decision.taskId === taskId) {
        results.push(structuredClone(decision));
      }
    }
    return results;
  }

  async listByMissionId(missionId: string): Promise<ReviewDecisionRecord[]> {
    const results: ReviewDecisionRecord[] = [];
    for (const decision of this.decisions.values()) {
      if (decision.missionId === missionId) {
        results.push(structuredClone(decision));
      }
    }
    return results;
  }

  async list(): Promise<ReviewDecisionRecord[]> {
    return Array.from(this.decisions.values()).map((d) => structuredClone(d));
  }

  /** Clear all data (for testing) */
  clear(): void {
    this.decisions.clear();
    this.byWorkflowId.clear();
  }
}
