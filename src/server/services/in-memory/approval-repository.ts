import type { Approval } from "@/core/contracts";

import type { ApprovalRepository } from "@/server/repositories/ports";
import type { InMemoryActionDecisionStore } from "./action-decision-store";

/**
 * Repository en mémoire des approbations (lecture seule au-dessus du store
 * partagé). L'enregistrement d'une décision passe exclusivement par l'unité de
 * travail transactionnelle. Travail interne synchrone, exposé en asynchrone.
 */
export class InMemoryApprovalRepository implements ApprovalRepository {
  constructor(private readonly store: InMemoryActionDecisionStore) {}

  async list(): Promise<Approval[]> {
    return [...this.store.listApprovals()];
  }

  async listForAction(actionId: string): Promise<Approval[]> {
    return [...this.store.listApprovalsForAction(actionId)];
  }
}
