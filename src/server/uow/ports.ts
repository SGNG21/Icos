import type { AgentAction, Approval, AuditEntry } from "@/core/contracts";

/**
 * Unité de travail transactionnelle pour une décision humaine.
 *
 * Elle applique, comme une opération logique unique, l'enregistrement de
 * l'approbation, la mise à jour de l'action et l'écriture de toutes les entrées
 * d'audit : soit l'ensemble réussit, soit rien n'est appliqué.
 *
 * L'implémentation mémoire garantit une section critique **non interruptible au
 * sein d'une instance JavaScript** (aucun `await` interne). Elle NE garantit
 * PAS la durabilité, ni la cohérence entre plusieurs processus ou instances, ni
 * l'isolation distribuée : ces propriétés viendront de la transaction
 * PostgreSQL (Lot 2A-2), derrière ce même port public.
 */
export interface ActionDecisionUnitOfWork {
  commitDecision(input: {
    approval: Approval;
    action: AgentAction;
    auditEntries: readonly AuditEntry[];
  }): Promise<CommitDecisionResult>;
}

export type CommitDecisionResult =
  | { ok: true; approval: Approval; action: AgentAction }
  | {
      ok: false;
      reason: "action_not_found" | "already_decided" | "audit_failed";
      message: string;
    };
