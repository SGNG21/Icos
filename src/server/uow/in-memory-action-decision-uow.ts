import type { AgentAction, Approval, AuditEntry } from "@/core/contracts";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";
import type { InMemoryActionDecisionStore } from "@/server/services/in-memory/action-decision-store";

import type { ActionDecisionUnitOfWork, CommitDecisionResult } from "./ports";

const TERMINAL: ReadonlySet<AgentAction["approvalStatus"]> = new Set(["approved", "rejected"]);

/**
 * Unité de travail transactionnelle EN MÉMOIRE pour une décision humaine.
 *
 * `commitDecision` est déclarée `async` (port asynchrone), mais son corps ne
 * contient AUCUN `await` : la section critique — revérification de l'état,
 * validation des entrées d'audit, `appendMany`, application de la décision —
 * s'exécute de façon entièrement synchrone au moment de l'appel, donc
 * NON INTERRUPTIBLE au sein d'une instance JavaScript. Elle utilise directement
 * le store et le journal d'audit SYNCHRONES internes, jamais des repositories
 * asynchrones.
 *
 * PORTÉE DE LA GARANTIE : cette atomicité vaut uniquement à l'intérieur d'une
 * instance JS. Elle N'assure PAS la durabilité, ni la cohérence entre plusieurs
 * processus/instances, ni l'isolation distribuée. Ces propriétés viendront de la
 * transaction PostgreSQL (Lot 2A-2), derrière le même port public.
 */
export class InMemoryActionDecisionUnitOfWork implements ActionDecisionUnitOfWork {
  constructor(
    private readonly store: InMemoryActionDecisionStore,
    private readonly auditLog: AuditLog,
  ) {}

  async commitDecision(input: {
    approval: Approval;
    action: AgentAction;
    auditEntries: readonly AuditEntry[];
  }): Promise<CommitDecisionResult> {
    const { approval, action, auditEntries } = input;

    // --- Début de section critique synchrone (aucun await ci-dessous) ---
    const currentStatus = this.store.approvalStatusOf(action.id);
    if (currentStatus === null) {
      return {
        ok: false,
        reason: "action_not_found",
        message: `action introuvable : ${action.id}`,
      };
    }

    // Défense au point de mutation : statut terminal ou décision déjà présente.
    if (TERMINAL.has(currentStatus) || this.store.hasApprovalForAction(action.id)) {
      return {
        ok: false,
        reason: "already_decided",
        message: `l'action ${action.id} a déjà reçu une décision définitive`,
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

    this.store.applyDecision(approval, action);
    // --- Fin de section critique synchrone ---

    return { ok: true, approval, action };
  }
}
