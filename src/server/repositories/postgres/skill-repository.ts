import { and, asc, eq, ne, sql } from "drizzle-orm";

import type { Skill, SkillListFilters } from "@/core/contracts/skill";
import { Database } from "@/server/database/client";
import { rowToSkill, skillToRow } from "@/server/database/mappers";
import {
  skills,
  skillSecurityScans,
  skillEvaluations,
} from "@/server/database/schema";
import type {
  SkillRepository,
  SkillSecurityScanRepository,
  SkillEvaluationRepository,
} from "@/server/repositories/skill-ports";
import type { Evaluation, SecurityScan } from "@/core/contracts/skill";
import {
  rowToSecurityScan,
  securityScanToRow,
  rowToSkillEval,
  skillEvalToRow,
} from "@/server/database/mappers";

export class PostgresSkillRepository implements SkillRepository {
  constructor(private readonly db: Database) {}

  async getById(id: string): Promise<Skill | null> {
    const rows = await this.db.select().from(skills).where(eq(skills.id, id)).limit(1);
    return rows.length === 0 ? null : rowToSkill(rows[0]);
  }

  async getByKeyAndVersion(tenantId: string, skillKey: string, version: string): Promise<Skill | null> {
    const rows = await this.db
      .select()
      .from(skills)
      .where(and(eq(skills.tenantId, tenantId), eq(skills.skillKey, skillKey), eq(skills.version, version)))
      .limit(1);
    return rows.length === 0 ? null : rowToSkill(rows[0]);
  }

  async getActiveVersion(tenantId: string, skillKey: string): Promise<Skill | null> {
    const rows = await this.db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.tenantId, tenantId),
          eq(skills.skillKey, skillKey),
          eq(skills.activationState, "active"),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : rowToSkill(rows[0]);
  }

  async list(tenantId: string, filters?: SkillListFilters): Promise<Skill[]> {
    const conditions = [eq(skills.tenantId, tenantId)];

    if (filters?.trustState) {
      conditions.push(eq(skills.trustState, filters.trustState));
    }
    if (filters?.activationState) {
      conditions.push(eq(skills.activationState, filters.activationState));
    }
    if (filters?.skillKey) {
      conditions.push(eq(skills.skillKey, filters.skillKey));
    }
    if (filters?.capabilityKey) {
      conditions.push(sql`${filters.capabilityKey} = any(${skills.capabilityKeys})`);
    }

    const rows = await this.db
      .select()
      .from(skills)
      .where(and(...conditions))
      .orderBy(asc(skills.createdAt), asc(skills.id));
    return rows.map(rowToSkill);
  }

  async create(skill: Skill): Promise<Skill> {
    const rows = await this.db.insert(skills).values(skillToRow(skill)).returning();
    return rowToSkill(rows[0]);
  }

  async updateTrustState(id: string, trustState: string): Promise<Skill | null> {
    const rows = await this.db
      .update(skills)
      .set({ trustState, updatedAt: new Date() })
      .where(eq(skills.id, id))
      .returning();
    return rows.length === 0 ? null : rowToSkill(rows[0]);
  }

  async updateActivationState(id: string, activationState: string): Promise<Skill | null> {
    const rows = await this.db
      .update(skills)
      .set({ activationState, updatedAt: new Date() })
      .where(eq(skills.id, id))
      .returning();
    return rows.length === 0 ? null : rowToSkill(rows[0]);
  }

  async updateContent(id: string, data: Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt">): Promise<Skill | null> {
    const row = skillToRow({ ...data, id, tenantId: "", createdAt: "", updatedAt: "" });
    const rows = await this.db
      .update(skills)
      .set({
        skillKey: row.skillKey,
        version: row.version,
        name: row.name,
        description: row.description,
        capabilityKeys: row.capabilityKeys,
        category: row.category,
        scripts: row.scripts,
        resources: row.resources,
        references: row.references,
        dependencyDeclarations: row.dependencyDeclarations,
        networkRequirements: row.networkRequirements,
        credentialRequirements: row.credentialRequirements,
        executionIsolationRequirement: row.executionIsolationRequirement,
        toolRequirements: row.toolRequirements,
        inputSchema: row.inputSchema,
        outputSchema: row.outputSchema,
        contentHash: row.contentHash,
        trustState: row.trustState,
        activationState: row.activationState,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, id))
      .returning();
    return rows.length === 0 ? null : rowToSkill(rows[0]);
  }

  async deactivateIfActive(tenantId: string, skillKey: string, excludingId: string): Promise<string | null> {
    const rows = await this.db
      .update(skills)
      .set({ activationState: "inactive", updatedAt: new Date() })
      .where(
        and(
          eq(skills.tenantId, tenantId),
          eq(skills.skillKey, skillKey),
          eq(skills.activationState, "active"),
          ne(skills.id, excludingId),
        ),
      )
      .returning({ id: skills.id });
    return rows.length === 0 ? null : rows[0].id;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id });
    return rows.length > 0;
  }
}

// ─────────────────────────────────────
// PostgresSkillSecurityScanRepository
// ─────────────────────────────────────

export class PostgresSkillSecurityScanRepository implements SkillSecurityScanRepository {
  constructor(private readonly db: Database) {}

  async create(scan: SecurityScan): Promise<SecurityScan> {
    const rows = await this.db.insert(skillSecurityScans).values(securityScanToRow(scan)).returning();
    return rowToSecurityScan(rows[0]);
  }

  async findValidForHash(skillId: string, contentHash: string): Promise<SecurityScan | null> {
    const rows = await this.db
      .select()
      .from(skillSecurityScans)
      .where(
        and(
          eq(skillSecurityScans.skillId, skillId),
          eq(skillSecurityScans.evaluatedContentHash, contentHash),
          eq(skillSecurityScans.status, "passed"),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : rowToSecurityScan(rows[0]);
  }

  async listBySkill(skillId: string): Promise<SecurityScan[]> {
    const rows = await this.db
      .select()
      .from(skillSecurityScans)
      .where(eq(skillSecurityScans.skillId, skillId))
      .orderBy(asc(skillSecurityScans.createdAt));
    return rows.map(rowToSecurityScan);
  }
}

// ─────────────────────────────────────
// PostgresSkillEvaluationRepository
// ─────────────────────────────────────

export class PostgresSkillEvaluationRepository implements SkillEvaluationRepository {
  constructor(private readonly db: Database) {}

  async create(evalRecord: Evaluation): Promise<Evaluation> {
    const rows = await this.db.insert(skillEvaluations).values(skillEvalToRow(evalRecord)).returning();
    return rowToSkillEval(rows[0]);
  }

  async findValidForHash(skillId: string, contentHash: string): Promise<Evaluation | null> {
    const rows = await this.db
      .select()
      .from(skillEvaluations)
      .where(
        and(
          eq(skillEvaluations.skillId, skillId),
          eq(skillEvaluations.evaluatedContentHash, contentHash),
          eq(skillEvaluations.status, "passed"),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : rowToSkillEval(rows[0]);
  }

  async listBySkill(skillId: string): Promise<Evaluation[]> {
    const rows = await this.db
      .select()
      .from(skillEvaluations)
      .where(eq(skillEvaluations.skillId, skillId))
      .orderBy(asc(skillEvaluations.createdAt));
    return rows.map(rowToSkillEval);
  }
}
