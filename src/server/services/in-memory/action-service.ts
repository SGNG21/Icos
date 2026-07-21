import type { AgentAction } from "@/core/contracts";

import type { ActionQuery, ActionService } from "../ports";
import type { InMemoryActionDecisionStore } from "./action-decision-store";

/**
 * Lecture seule des actions au-dessus du store partagé. Les mutations passent
 * exclusivement par l'unité de travail transactionnelle.
 */
export class InMemoryActionService implements ActionService {
  constructor(private readonly store: InMemoryActionDecisionStore) {}

  list(filter?: ActionQuery): readonly AgentAction[] {
    return this.store.listActions(filter);
  }

  getById(id: string): AgentAction | undefined {
    return this.store.getAction(id);
  }
}
