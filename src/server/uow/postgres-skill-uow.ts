import type { AuditEntry } from "@/core/contracts";
import { eq, and, sql } from "drizzle-orm";
import type { Database } from "@/server/database/client";
import { skills } from "@/server/database/schema";
import { rowToSkill } from "@/server/database/mappers";
import { auditToRow } from "@/server/database/mappers";
import { auditEntries } from "@/server/database/schema";
import type { SkillUnitOfWork, SkillUowResult } from "@/server/uow/ports";

/**
 * Implémentation PostgreSQL du SkillUnitOfWork.
 * Chaque méthode utilise une transaction DB avec verrouillage FOR UPDATE
 * pour garantir l'atomicité et la cohérence concurrente.
 */
export class PostgresSkillUnitOfWork implements SkillUnitOfWork {
  constructor(private readonly db: Database) {}

  async activateVersionWithAudit(input: {
    skill: import("@/core/contracts/skill").Skill;
    tenantId: string;
    skillKey: string;
    actorLabel: string;
    deactivationAudit: AuditEntry;
    activationAudit: AuditEntry;
  }): Promise<
    SkillUowResult<{
      skill: import("@/core/contracts/skill").Skill;
      deactivatedVersionId: string | null;
    }>
  > {
    return this.db.transaction(async (tx) => {
      // 1. FOR UPDATE sur les versions du skillKey
      const locked = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.tenantId, input.tenantId), eq(skills.skillKey, input.skillKey)))
        .for("update");

      // 2. Désactiver l'ancienne version active
      let deactivatedVersionId: string | null = null;
      for (const row of locked) {
        if (row.activationState === "active" && row.id !== input.skill.id) {
          await tx
            .update(skills)
            .set({ activationState: "inactive", updatedAt: new Date() })
            .where(eq(skills.id, row.id));
          deactivatedVersionId = row.id;
        }
      }

      // 3. Activer la nouvelle version
      const activated = await tx
        .update(skills)
        .set({ activationState: "active", updatedAt: new Date() })
        .where(eq(skills.id, input.skill.id))
        .returning();

      if (activated.length === 0) {
        return tx.rollback() as never;
      }

      // 4. Audit : désactivation
      if (deactivatedVersionId !== null) {
        await tx.insert(auditEntries).values(auditToRow(input.deactivationAudit));
      }

      // 5. Audit : activation
      await tx.insert(auditEntries).values(auditToRow(input.activationAudit));

      return { ok: true, data: { skill: rowToSkill(activated[0]), deactivatedVersionId } } as const;
    });
  }

  async rejectSkillWithAudit(input: {
    id: string;
    trustAudit: AuditEntry;
    activationAudit: AuditEntry;
  }): Promise<SkillUowResult<{ skill: import("@/core/contracts/skill").Skill }>> {
    return this.db.transaction(async (tx) => {
      // 1. FOR UPDATE
      const [locked] = await tx
        .select()
        .from(skills)
        .where(eq(skills.id, input.id))
        .for("update")
        .limit(1);
      if (!locked) {
        return { ok: false, reason: "skill_not_found", message: "Skill not found" };
      }

      // 2. trustState = rejected
      await tx
        .update(skills)
        .set({ trustState: "rejected", updatedAt: new Date() })
        .where(eq(skills.id, input.id));

      // 3. activationState = revoked
      const updated = await tx
        .update(skills)
        .set({ activationState: "revoked", updatedAt: new Date() })
        .where(eq(skills.id, input.id))
        .returning();

      if (updated.length === 0) {
        return tx.rollback() as never;
      }

      // 4. Audit
      await tx.insert(auditEntries).values(auditToRow(input.trustAudit));
      await tx.insert(auditEntries).values(auditToRow(input.activationAudit));

      return { ok: true, data: { skill: rowToSkill(updated[0]) } } as const;
    });
  }
}
