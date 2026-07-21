import type { Approval } from "@/core/contracts";

import type { ApprovalService } from "../ports";
import type { InMemoryActionDecisionStore } from "./action-decision-store";

/**
 * Lecture seule des approbations au-dessus du store partagé. L'enregistrement
 * d'une décision passe exclusivement par l'unité de travail transactionnelle
 * (`ActionDecisionUnitOfWork`), afin de garantir l'atomicité approbation +
 * action + audit.
 */
export class InMemoryApprovalService implements ApprovalService {
  constructor(private readonly store: InMemoryActionDecisionStore) {}

  list(): readonly Approval[] {
    return this.store.listApprovals();
  }

  listForAction(actionId: string): readonly Approval[] {
    return this.store.listApprovalsForAction(actionId);
  }
}
