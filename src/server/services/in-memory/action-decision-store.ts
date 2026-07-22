import {
  agentActionSchema,
  approvalSchema,
  type AgentAction,
  type Approval,
} from "@/core/contracts";
import { compareActions, compareApprovals } from "@/core/ordering";

import type { ActionQuery } from "@/server/repositories/ports";

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
      .map((action) => structuredClone(action))
      .sort(compareActions);
  }

  getAction(id: string): AgentAction | undefined {
    const action = this.actions.find((candidate) => candidate.id === id);
    return action ? structuredClone(action) : undefined;
  }

  hasAction(id: string): boolean {
    return this.actions.some((candidate) => candidate.id === id);
  }

  /** Statut d'approbation courant d'une action (synchrone, sans copie). */
  approvalStatusOf(id: string): AgentAction["approvalStatus"] | null {
    return this.actions.find((candidate) => candidate.id === id)?.approvalStatus ?? null;
  }

  /** Vrai si une décision a déjà été enregistrée pour cette action. */
  hasApprovalForAction(actionId: string): boolean {
    return this.approvals.some((approval) => approval.actionId === actionId);
  }

  listApprovals(): readonly Approval[] {
    return this.approvals.map((approval) => structuredClone(approval)).sort(compareApprovals);
  }

  listApprovalsForAction(actionId: string): readonly Approval[] {
    return this.approvals
      .filter((approval) => approval.actionId === actionId)
      .map((approval) => structuredClone(approval))
      .sort(compareApprovals);
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
