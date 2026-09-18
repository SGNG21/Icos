import { eq, asc, inArray } from "drizzle-orm";

import type { Database } from "@/server/database/client";
import { decisions } from "@/server/database/schema";
import { rowToReviewDecision, reviewDecisionToRow } from "@/server/database/mappers";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";

/**
 * Repository PostgreSQL des décisions de revue (Reviewer V1).
 *
 * INVARIANTS :
 * - idempotence portée par la contrainte UNIQUE `workflow_id` : le rejeu d'une
 *   même revue retourne l'enregistrement existant sans doublon ni écrasement ;
 * - atomicité : l'écriture de la décision se fait dans une transaction courte ;
 * - AUCUN appel externe n'est effectué ici.
 */
export class PostgresReviewDecisionRepository implements ReviewDecisionRepository {
  constructor(private readonly db: Database) {}

  async save(decision: ReviewDecisionRecord): Promise<ReviewDecisionRecord> {
    // Court-circuit idempotent AVANT toute écriture
    const existing = await this.getByWorkflowId(decision.workflowId);
    if (existing) {
      return existing;
    }

    try {
      return await this.db.transaction(async (tx) => {
        await tx.insert(decisions).values(reviewDecisionToRow(decision));
        return decision;
      });
    } catch (error) {
      // Course concurrente sur la contrainte UNIQUE
      const raced = await this.getByWorkflowId(decision.workflowId);
      if (raced) {
        return raced;
      }
      throw error;
    }
  }

  async getById(id: string): Promise<ReviewDecisionRecord | null> {
    const rows = await this.db.select().from(decisions).where(eq(decisions.id, id)).limit(1);
    return rows[0] ? rowToReviewDecision(rows[0]) : null;
  }

  async getByWorkflowId(workflowId: string): Promise<ReviewDecisionRecord | null> {
    const rows = await this.db
      .select()
      .from(decisions)
      .where(eq(decisions.workflowId, workflowId))
      .limit(1);
    return rows[0] ? rowToReviewDecision(rows[0]) : null;
  }

  async listByTaskId(taskId: string): Promise<ReviewDecisionRecord[]> {
    const rows = await this.db
      .select()
      .from(decisions)
      .where(eq(decisions.taskId, taskId))
      .orderBy(asc(decisions.createdAt));
    return rows.map(rowToReviewDecision);
  }

  async listByMissionId(missionId: string): Promise<ReviewDecisionRecord[]> {
    const rows = await this.db
      .select()
      .from(decisions)
      .where(eq(decisions.missionId, missionId))
      .orderBy(asc(decisions.createdAt));
    return rows.map(rowToReviewDecision);
  }

  async list(): Promise<ReviewDecisionRecord[]> {
    const rows = await this.db.select().from(decisions).orderBy(asc(decisions.createdAt));
    return rows.map(rowToReviewDecision);
  }
}
