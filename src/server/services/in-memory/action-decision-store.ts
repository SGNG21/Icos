import {
  agentActionSchema,
  approvalSchema,
  type AgentAction,
  type Approval,
} from "@/core/contracts";

import type { ActionQuery } from "../ports";

/**
 * Source unique de vérité en mémoire pour les actions et les approbations.
 *
 * Les services de lecture (`ActionService`, `ApprovalService`) et l'unité de
 * travail transactionnelle (`ActionDecisionUnitOfWork`) partagent CE store :
 * les lectures renvoient des copies défensives, et l'application d'une décision
 * est une écriture synchrone unique (approbation + action) qui ne peut pas
 * échouer une fois les validations et l'audit réalisés en amont.
 */
export class InMemoryActionDecisionStore {
  private readonly actions: AgentAction[];
  private readonly approvals: Approval[] = [];

  constructor(seedActions: readonly AgentAction[] = []) {
    this.actions = seedActions.map((action) => agentActionSchema.parse(structuredClone(action)));
  }

  listActions(filter?: ActionQuery): readonly AgentAction[] {
    return this.actions
      .filter(
        (action) =>
          filter?.approvalStatus === undefined || action.approvalStatus === filter.approvalStatus,
      )
      .map((action) => structuredClone(action));
  }

  getAction(id: string): AgentAction | undefined {
    const action = this.actions.find((candidate) => candidate.id === id);
    return action ? structuredClone(action) : undefined;
  }

  hasAction(id: string): boolean {
    return this.actions.some((candidate) => candidate.id === id);
  }

  listApprovals(): readonly Approval[] {
    return this.approvals.map((approval) => structuredClone(approval));
  }

  listApprovalsForAction(actionId: string): readonly Approval[] {
    return this.approvals
      .filter((approval) => approval.actionId === actionId)
      .map((approval) => structuredClone(approval));
  }

  /**
   * Application synchrone unique d'une décision validée : enregistre
   * l'approbation et remplace l'action. Appelée uniquement par l'unité de
   * travail, après validation des références et écriture de l'audit.
   */
  applyDecision(approval: Approval, action: AgentAction): void {
    const index = this.actions.findIndex((candidate) => candidate.id === action.id);
    if (index === -1) {
      throw new Error(`action introuvable à l'application : ${action.id}`);
    }
    this.actions[index] = agentActionSchema.parse(structuredClone(action));
    this.approvals.push(approvalSchema.parse(structuredClone(approval)));
  }
}
