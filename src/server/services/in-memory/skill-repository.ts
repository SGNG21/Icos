import type { Skill } from "@/core/contracts/skill";
import type {
  SkillRepository,
  SkillSecurityScanRepository,
  SkillEvaluationRepository,
} from "@/server/repositories/skill-ports";
import type { Evaluation, SecurityScan, SkillListFilters } from "@/core/contracts/skill";
import { skillSchema } from "@/core/contracts/skill";

// ─────────────────────────────────────
// InMemorySkillRepository
// ─────────────────────────────────────

export class InMemorySkillRepository implements SkillRepository {
  private _skills: Map<string, Skill> = new Map();

  async getById(id: string): Promise<Skill | null> {
    return this._skills.get(id) ?? null;
  }

  async getByKeyAndVersion(
    tenantId: string,
    skillKey: string,
    version: string,
  ): Promise<Skill | null> {
    for (const skill of this._skills.values()) {
      if (skill.tenantId === tenantId && skill.skillKey === skillKey && skill.version === version) {
        return skill;
      }
    }
    return null;
  }

  async getActiveVersion(tenantId: string, skillKey: string): Promise<Skill | null> {
    for (const skill of this._skills.values()) {
      if (
        skill.tenantId === tenantId &&
        skill.skillKey === skillKey &&
        skill.activationState === "active"
      ) {
        return skill;
      }
    }
    return null;
  }

  async list(tenantId: string, filters?: SkillListFilters): Promise<Skill[]> {
    let result = Array.from(this._skills.values()).filter((s) => s.tenantId === tenantId);

    if (filters?.trustState) {
      result = result.filter((s) => s.trustState === filters.trustState);
    }
    if (filters?.activationState) {
      result = result.filter((s) => s.activationState === filters.activationState);
    }
    if (filters?.skillKey) {
      result = result.filter((s) => s.skillKey === filters.skillKey);
    }
    if (filters?.capabilityKey) {
      result = result.filter((s) => s.capabilityKeys.includes(filters.capabilityKey!));
    }

    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(skill: Skill): Promise<Skill> {
    const parsed = skillSchema.parse(skill);
    this._skills.set(parsed.id, parsed);
    return parsed;
  }

  async updateTrustState(id: string, trustState: string): Promise<Skill | null> {
    const skill = this._skills.get(id);
    if (!skill) return null;
    const updated = {
      ...skill,
      trustState: trustState as Skill["trustState"],
      updatedAt: new Date().toISOString(),
    };
    const parsed = skillSchema.parse(updated);
    this._skills.set(id, parsed);
    return parsed;
  }

  async updateActivationState(id: string, activationState: string): Promise<Skill | null> {
    const skill = this._skills.get(id);
    if (!skill) return null;
    const updated = {
      ...skill,
      activationState: activationState as Skill["activationState"],
      updatedAt: new Date().toISOString(),
    };
    const parsed = skillSchema.parse(updated);
    this._skills.set(id, parsed);
    return parsed;
  }

  async updateContent(
    id: string,
    data: Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt">,
  ): Promise<Skill | null> {
    const existing = this._skills.get(id);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...data,
      updatedAt: new Date().toISOString(),
    };
    const parsed = skillSchema.parse(updated);
    this._skills.set(id, parsed);
    return parsed;
  }

  async deactivateIfActive(
    tenantId: string,
    skillKey: string,
    excludingId: string,
  ): Promise<string | null> {
    for (const skill of this._skills.values()) {
      if (
        skill.tenantId === tenantId &&
        skill.skillKey === skillKey &&
        skill.activationState === "active" &&
        skill.id !== excludingId
      ) {
        const updated = {
          ...skill,
          activationState: "inactive" as const,
          updatedAt: new Date().toISOString(),
        };
        this._skills.set(skill.id, skillSchema.parse(updated));
        return skill.id;
      }
    }
    return null;
  }

  async delete(id: string): Promise<boolean> {
    return this._skills.delete(id);
  }
}

// ─────────────────────────────────────
// InMemorySkillSecurityScanRepository
// ─────────────────────────────────────

export class InMemorySkillSecurityScanRepository implements SkillSecurityScanRepository {
  private _scans: Map<string, SecurityScan> = new Map();

  async create(scan: SecurityScan): Promise<SecurityScan> {
    this._scans.set(scan.id, scan);
    return scan;
  }

  async findValidForHash(skillId: string, contentHash: string): Promise<SecurityScan | null> {
    for (const scan of this._scans.values()) {
      if (
        scan.skillId === skillId &&
        scan.evaluatedContentHash === contentHash &&
        scan.status === "passed"
      ) {
        return scan;
      }
    }
    return null;
  }

  async listBySkill(skillId: string): Promise<SecurityScan[]> {
    return Array.from(this._scans.values())
      .filter((s) => s.skillId === skillId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

// ─────────────────────────────────────
// InMemorySkillEvaluationRepository
// ─────────────────────────────────────

export class InMemorySkillEvaluationRepository implements SkillEvaluationRepository {
  private _evals: Map<string, Evaluation> = new Map();

  async create(evalRecord: Evaluation): Promise<Evaluation> {
    this._evals.set(evalRecord.id, evalRecord);
    return evalRecord;
  }

  async findValidForHash(skillId: string, contentHash: string): Promise<Evaluation | null> {
    for (const evalRecord of this._evals.values()) {
      if (
        evalRecord.skillId === skillId &&
        evalRecord.evaluatedContentHash === contentHash &&
        evalRecord.status === "passed"
      ) {
        return evalRecord;
      }
    }
    return null;
  }

  async listBySkill(skillId: string): Promise<Evaluation[]> {
    return Array.from(this._evals.values())
      .filter((e) => e.skillId === skillId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
