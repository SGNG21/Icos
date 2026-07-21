import { randomUUID } from "node:crypto";

import { approvalSchema, type Approval, type AuditEntry } from "@/core/contracts";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";

import type { ApprovalService, RecordApprovalInput, RecordApprovalResult } from "../ports";

/**
 * Implémentation temporaire en mémoire (voir avertissement dans
 * `src/server/audit/in-memory-audit-log.ts`). Même discipline que
 * `InMemoryTaskService` : l'entrée d'audit est enregistrée avant d'appliquer
 * la mutation ; en cas d'échec de l'audit, la décision n'est pas conservée.
 */
export class InMemoryApprovalService implements ApprovalService {
  private readonly approvals: Approval[] = [];

  constructor(private readonly auditLog: AuditLog) {}

  list(): readonly Approval[] {
    return this.approvals.map((approval) => structuredClone(approval));
  }

  listForAction(actionId: string): readonly Approval[] {
    return this.approvals
      .filter((approval) => approval.actionId === actionId)
      .map((approval) => structuredClone(approval));
  }

  recordDecision(input: RecordApprovalInput): RecordApprovalResult {
    const now = new Date().toISOString();
    const candidate: Approval = {
      id: `approval-${randomUUID()}`,
      actionId: input.actionId,
      decidedBy: input.decidedBy,
      decision: input.decision,
      reason: input.reason,
      decidedAt: now,
    };

    const parsed = approvalSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_input", message: parsed.error.message };
    }

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "approval.recorded",
      actor: { kind: "human", id: input.decidedBy },
      actionId: parsed.data.actionId,
      details: { decision: parsed.data.decision, reason: parsed.data.reason ?? null },
    };

    try {
      this.auditLog.append(auditEntry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: "audit_failed", message };
    }

    this.approvals.push(parsed.data);
    return { ok: true, approval: structuredClone(parsed.data) };
  }
}
