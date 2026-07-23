import type { AgentAction } from "@/core/contracts";

import type { ActionQuery, ActionRepository, AgentScope } from "@/server/repositories/ports";
import type { InMemoryActionDecisionStore } from "./action-decision-store";

/**
 * Repository en mémoire des actions (lecture seule au-dessus du store partagé).
 * Les mutations passent exclusivement par l'unité de travail transactionnelle.
 * Travail interne synchrone, exposé derrière un port asynchrone.
 */
export class InMemoryActionRepository implements ActionRepository {
  constructor(private readonly store: InMemoryActionDecisionStore) {}

  async list(filter?: ActionQuery): Promise<AgentAction[]> {
    return [...this.store.listActions(filter)];
  }

  async listForScope(scope: AgentScope, filter?: ActionQuery): Promise<AgentAction[]> {
    const actions = await this.list(filter);
    return scope.kind === "global"
      ? actions
      : actions.filter((action) => scope.agentIds.has(action.initiatedByAgentId));
  }

  async getById(id: string): Promise<AgentAction | null> {
    return this.store.getAction(id) ?? null;
  }

  async getByIdForScope(id: string, scope: AgentScope): Promise<AgentAction | null> {
    const action = await this.getById(id);
    if (
      action === null ||
      scope.kind === "global" ||
      scope.agentIds.has(action.initiatedByAgentId)
    ) {
      return action;
    }

    return null;
  }
}
