import type { AgentAction, Approval, AuditEntry } from "@/core/contracts";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";
import type { ActionDecisionUnitOfWork, CommitDecisionResult } from "@/server/services/ports";
import type { InMemoryActionDecisionStore } from "@/server/services/in-memory/action-decision-store";

/**
 * Unité de travail transactionnelle EN MÉMOIRE pour une décision humaine.
 *
 * Séquence garantissant l'absence d'état partiel :
 * 1. vérifier que l'action existe encore dans le store (sinon rien n'est
 *    appliqué : ni approbation, ni audit) ;
 * 2. écrire TOUTES les entrées d'audit de façon atomique (`appendMany` valide
 *    toutes les entrées avant d'en écrire une seule) ; en cas d'échec, ni
 *    l'approbation ni l'action ne sont modifiées ;
 * 3. appliquer l'approbation et l'action mise à jour par une écriture
 *    synchrone unique qui ne peut plus échouer.
 *
 * Ce n'est PAS une transaction réelle : il n'existe aucune isolation ni
 * durabilité. PostgreSQL remplacera cette unité par une vraie transaction
 * atomique (roadmap phase 1).
 */
export class InMemoryActionDecisionUnitOfWork implements ActionDecisionUnitOfWork {
  constructor(
    private readonly store: InMemoryActionDecisionStore,
    private readonly auditLog: AuditLog,
  ) {}

  commitDecision(input: {
    approval: Approval;
    action: AgentAction;
    auditEntries: readonly AuditEntry[];
  }): CommitDecisionResult {
    const { approval, action, auditEntries } = input;

    if (!this.store.hasAction(action.id)) {
      return {
        ok: false,
        reason: "action_not_found",
        message: `action introuvable : ${action.id}`,
      };
    }

    try {
      this.auditLog.appendMany(auditEntries);
    } catch (error) {
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // Écriture synchrone finale : ne peut plus échouer une fois l'audit écrit.
    this.store.applyDecision(approval, action);

    return { ok: true, approval, action };
  }
}
