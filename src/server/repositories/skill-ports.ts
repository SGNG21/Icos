import type {
  Evaluation,
  SecurityFinding,
  SecurityScan,
  Skill,
  SkillListFilters,
} from "@/core/contracts/skill";

export interface SkillRepository {
  getById(id: string): Promise<Skill | null>;
  getByKeyAndVersion(tenantId: string, skillKey: string, version: string): Promise<Skill | null>;
  getActiveVersion(tenantId: string, skillKey: string): Promise<Skill | null>;
  list(tenantId: string, filters?: SkillListFilters): Promise<Skill[]>;
  create(skill: Skill): Promise<Skill>;
  updateTrustState(id: string, trustState: string): Promise<Skill | null>;
  updateActivationState(id: string, activationState: string): Promise<Skill | null>;
  updateContent(id: string, skill: Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt">): Promise<Skill | null>;
  deactivateIfActive(tenantId: string, skillKey: string, excludingId: string): Promise<string | null>;
  delete(id: string): Promise<boolean>;
}

export interface SkillSecurityScanRepository {
  create(scan: SecurityScan): Promise<SecurityScan>;
  findValidForHash(skillId: string, contentHash: string): Promise<SecurityScan | null>;
  listBySkill(skillId: string): Promise<SecurityScan[]>;
}

export interface SkillEvaluationRepository {
  create(evalRecord: Evaluation): Promise<Evaluation>;
  findValidForHash(skillId: string, contentHash: string): Promise<Evaluation | null>;
  listBySkill(skillId: string): Promise<Evaluation[]>;
}
