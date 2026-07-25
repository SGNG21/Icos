import type { AuditEntry } from "@/core/contracts";
import type { Skill } from "@/core/contracts/skill";
import type { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import type { InMemorySkillRepository } from "@/server/services/in-memory/skill-repository";
import type { SkillUnitOfWork, SkillUowResult } from "@/server/uow/ports";

/**
 * Implémentation mémoire du SkillUnitOfWork.
 * Section critique non interruptible au sein d'une instance JS.
 * NE garantit PAS la durabilité ni la cohérence multi-instances.
 */
export class InMemorySkillUnitOfWork implements SkillUnitOfWork {
  constructor(
    private readonly skills: InMemorySkillRepository,
    private readonly auditLog: InMemoryAuditLog,
  ) {}

  async activateVersionWithAudit(input: {
    skill: Skill;
    tenantId: string;
    skillKey: string;
    actorLabel: string;
    deactivationAudit: AuditEntry;
    activationAudit: AuditEntry;
  }): Promise<SkillUowResult<{ skill: Skill; deactivatedVersionId: string | null }>> {
    // Désactiver l'ancienne version active
    const deactivatedId = await this.skills.deactivateIfActive(
      input.tenantId,
      input.skillKey,
      input.skill.id,
    );

    // Activer la nouvelle version
    const updated = await this.skills.updateActivationState(input.skill.id, "active");
    if (!updated) {
      return { ok: false, reason: "skill_not_found", message: "Skill not found for activation" };
    }

    // Audit de désactivation (si une version était active)
    if (deactivatedId !== null) {
      this.auditLog.append(input.deactivationAudit);
    }

    // Audit d'activation
    this.auditLog.append(input.activationAudit);

    return { ok: true, data: { skill: updated, deactivatedVersionId: deactivatedId } };
  }

  async rejectSkillWithAudit(input: {
    id: string;
    trustAudit: AuditEntry;
    activationAudit: AuditEntry;
  }): Promise<SkillUowResult<{ skill: Skill }>> {
    // Mettre à jour trustState
    const trustUpdated = await this.skills.updateTrustState(input.id, "rejected");
    if (!trustUpdated) {
      return { ok: false, reason: "skill_not_found", message: "Skill not found" };
    }

    // Mettre à jour activationState
    const activationUpdated = await this.skills.updateActivationState(input.id, "revoked");
    if (!activationUpdated) {
      return { ok: false, reason: "skill_not_found", message: "Skill not found for activation update" };
    }

    // Audit
    this.auditLog.append(input.trustAudit);
    this.auditLog.append(input.activationAudit);

    return { ok: true, data: { skill: activationUpdated } };
  }
}
