import { randomUUID } from "node:crypto";
import type { AuditEntry } from "@/core/contracts";
import {
  skillSchema,
  trustStateSchema,
  activationStateSchema,
  type Skill,
  type SkillListFilters,
} from "@/core/contracts/skill";
import type { AuditRepository } from "@/server/repositories/ports";
import type {
  SkillRepository,
  SkillSecurityScanRepository,
  SkillEvaluationRepository,
} from "@/server/repositories/skill-ports";
import type { SkillUnitOfWork } from "@/server/uow/ports";
import type { Evaluation, SecurityScan } from "@/core/contracts/skill";
import {
  isTrustTransitionAllowed,
  isActivationTransitionAllowed,
  isContentMutable,
} from "@/core/skills/lifecycle";
import { computeSkillHash } from "@/core/skills/hash";

export type SkillServiceResult<T> =
  { ok: true; data: T } | { ok: false; reason: string; message: string };

export interface ActorInfo {
  actorKind: "agent" | "human" | "system";
  actorLabel: string;
}

export class SkillService {
  constructor(
    private readonly skills: SkillRepository,
    private readonly scans: SkillSecurityScanRepository,
    private readonly evals: SkillEvaluationRepository,
    private readonly audit: AuditRepository,
    private readonly uow: SkillUnitOfWork,
  ) {}

  // ─────────────────────────────────────
  // Création / Import
  // ─────────────────────────────────────

  /**
   * Importe un skill depuis une source externe.
   * trustState = untrusted, activationState = inactive.
   */
  async importSkill(input: {
    skill: Omit<
      Skill,
      "id" | "trustState" | "activationState" | "contentHash" | "createdAt" | "updatedAt"
    >;
    actor: ActorInfo;
  }): Promise<SkillServiceResult<{ skill: Skill }>> {
    const now = new Date().toISOString();
    const skill: Skill = {
      ...input.skill,
      id: randomUUID(),
      trustState: "untrusted",
      activationState: "inactive",
      contentHash: "",
      createdAt: now,
      updatedAt: now,
    };

    // Calculer le hash avant d'avoir l'ID (le hash n'inclut pas l'ID)
    const hash = computeSkillHash(skill);
    const finalSkill = skillSchema.parse({
      ...skill,
      contentHash: hash,
      provenance: { ...skill.provenance, contentHash: hash },
    });

    const created = await this.skills.create(finalSkill);

    // Audit
    await this.audit.append({
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.imported",
      actor: { kind: input.actor.actorKind, id: input.actor.actorLabel },
      details: {
        skillKey: created.skillKey,
        version: created.version,
        source: created.provenance.source,
        contentHash: created.contentHash,
      },
    });

    return { ok: true, data: { skill: created } };
  }

  /**
   * Crée un skill interne (déjà présent dans le registre).
   * trustState et activationState sont initialisés par le service.
   */
  async createSkill(input: {
    skill: Omit<
      Skill,
      "id" | "trustState" | "activationState" | "contentHash" | "createdAt" | "updatedAt"
    >;
    actor: ActorInfo;
  }): Promise<SkillServiceResult<{ skill: Skill }>> {
    const now = new Date().toISOString();
    const partial: Skill = {
      ...input.skill,
      id: randomUUID(),
      trustState: "untrusted",
      activationState: "inactive",
      contentHash: "",
      createdAt: now,
      updatedAt: now,
    };

    const hash = computeSkillHash(partial);
    const skill = skillSchema.parse({
      ...partial,
      contentHash: hash,
      provenance: { ...partial.provenance, contentHash: hash },
    });

    const created = await this.skills.create(skill);

    await this.audit.append({
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.created",
      actor: { kind: input.actor.actorKind, id: input.actor.actorLabel },
      details: { skillKey: created.skillKey, version: created.version },
    });

    return { ok: true, data: { skill: created } };
  }

  // ─────────────────────────────────────
  // Trust State Transitions
  // ─────────────────────────────────────

  private async transitionTrust(
    id: string,
    targetTrustState: string,
    actor: ActorInfo,
    isHumanOnly: boolean,
  ): Promise<SkillServiceResult<{ skill: Skill }>> {
    if (isHumanOnly && actor.actorKind !== "human") {
      return {
        ok: false,
        reason: "human_only",
        message: "Cette transition nécessite un acteur humain",
      };
    }

    const parsed = trustStateSchema.safeParse(targetTrustState);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_state", message: "Invalid trust state" };
    }
    const to = parsed.data;

    const skill = await this.skills.getById(id);
    if (!skill) {
      return { ok: false, reason: "not_found", message: "Skill not found" };
    }

    if (!isTrustTransitionAllowed(skill.trustState, to)) {
      return {
        ok: false,
        reason: "invalid_transition",
        message: `Transition ${skill.trustState} → ${to} non autorisée`,
      };
    }

    // Si rejected, vérifier le cross-invariant
    if (to === "rejected") {
      return this.rejectSkill(id, skill, actor);
    }

    // Transition normale
    const updated = await this.skills.updateTrustState(id, to);
    if (!updated) {
      return { ok: false, reason: "update_failed", message: "Échec de mise à jour du trust state" };
    }

    // Audit
    await this.audit.append({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      eventType: "skill.trust_changed",
      actor: { kind: actor.actorKind, id: actor.actorLabel },
      details: {
        skillKey: skill.skillKey,
        version: skill.version,
        previousTrustState: skill.trustState,
        newTrustState: to,
      },
    });

    return { ok: true, data: { skill: updated } };
  }

  /**
   * Transition vers rejected — atomique avec revoked.
   */
  private async rejectSkill(
    id: string,
    skill: Skill,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ skill: Skill }>> {
    const now = new Date().toISOString();

    const trustAudit: AuditEntry = {
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.trust_changed",
      actor: { kind: actor.actorKind, id: actor.actorLabel },
      details: {
        skillKey: skill.skillKey,
        version: skill.version,
        previousTrustState: skill.trustState,
        newTrustState: "rejected",
      },
    };

    const activationAudit: AuditEntry = {
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.activation_changed",
      actor: { kind: actor.actorKind, id: actor.actorLabel },
      details: {
        skillKey: skill.skillKey,
        version: skill.version,
        previousActivationState: skill.activationState,
        newActivationState: "revoked",
      },
    };

    const result = await this.uow.rejectSkillWithAudit({
      id,
      trustAudit,
      activationAudit,
    });

    if (!result.ok) {
      return result;
    }

    return { ok: true, data: { skill: result.data.skill } };
  }

  async quarantineSkill(
    id: string,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ skill: Skill }>> {
    return this.transitionTrust(id, "quarantined", actor, false);
  }

  async reviewSkill(id: string, actor: ActorInfo): Promise<SkillServiceResult<{ skill: Skill }>> {
    return this.transitionTrust(id, "reviewed", actor, false);
  }

  async approveSkill(id: string, actor: ActorInfo): Promise<SkillServiceResult<{ skill: Skill }>> {
    return this.transitionTrust(id, "approved", actor, true);
  }

  async rejectSkillAction(
    id: string,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ skill: Skill }>> {
    return this.transitionTrust(id, "rejected", actor, false);
  }

  // ─────────────────────────────────────
  // Activation State Transitions
  // ─────────────────────────────────────

  private async transitionActivation(
    id: string,
    targetActivationState: string,
    actor: ActorInfo,
    isHumanOnly: boolean,
  ): Promise<SkillServiceResult<{ skill: Skill; deactivatedVersionId?: string | null }>> {
    if (isHumanOnly && actor.actorKind !== "human") {
      return {
        ok: false,
        reason: "human_only",
        message: "Cette transition nécessite un acteur humain",
      };
    }

    const parsed = activationStateSchema.safeParse(targetActivationState);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_state", message: "Invalid activation state" };
    }
    const to = parsed.data as import("@/core/contracts/skill").ActivationState;

    const skill = await this.skills.getById(id);
    if (!skill) {
      return { ok: false, reason: "not_found", message: "Skill not found" };
    }

    if (!isActivationTransitionAllowed(skill.activationState, to)) {
      return {
        ok: false,
        reason: "invalid_transition",
        message: `Transition ${skill.activationState} → ${to} non autorisée`,
      };
    }

    // Vérifier cross-invariant : active ⇒ approved
    if (to === "active" && skill.trustState !== "approved") {
      return {
        ok: false,
        reason: "trust_not_approved",
        message: "Impossible d'activer un skill dont trustState n'est pas approved",
      };
    }

    const now = new Date().toISOString();

    // Activation spéciale : doit être atomique avec désactivation de l'ancienne version
    if (to === "active") {
      const deactivationAudit: AuditEntry = {
        id: randomUUID(),
        occurredAt: now,
        eventType: "skill.activation_changed",
        actor: { kind: "system", id: "skill-service" },
        details: {
          skillKey: skill.skillKey,
          previousActivationState: "active",
          newActivationState: "inactive",
          replacedBy: id,
        },
      };

      const activationAudit: AuditEntry = {
        id: randomUUID(),
        occurredAt: now,
        eventType: "skill.activation_changed",
        actor: { kind: actor.actorKind, id: actor.actorLabel },
        details: {
          skillKey: skill.skillKey,
          version: skill.version,
          previousActivationState: skill.activationState,
          newActivationState: "active",
        },
      };

      const result = await this.uow.activateVersionWithAudit({
        skill,
        tenantId: skill.tenantId,
        skillKey: skill.skillKey,
        actorLabel: actor.actorLabel,
        deactivationAudit,
        activationAudit,
      });

      return result;
    }

    // Transitions simples (suspended, revoked, inactive)
    const updated = await this.skills.updateActivationState(id, to);
    if (!updated) {
      return { ok: false, reason: "update_failed", message: "Échec de mise à jour" };
    }

    await this.audit.append({
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.activation_changed",
      actor: { kind: actor.actorKind, id: actor.actorLabel },
      details: {
        skillKey: skill.skillKey,
        version: skill.version,
        previousActivationState: skill.activationState,
        newActivationState: to,
      },
    });

    return { ok: true, data: { skill: updated } };
  }

  async activateSkill(
    id: string,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ skill: Skill; deactivatedVersionId?: string | null }>> {
    return this.transitionActivation(id, "active", actor, true);
  }

  async suspendSkill(id: string, actor: ActorInfo): Promise<SkillServiceResult<{ skill: Skill }>> {
    return this.transitionActivation(id, "suspended", actor, true);
  }

  async reactivateSkill(
    id: string,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ skill: Skill }>> {
    return this.transitionActivation(id, "active", actor, true);
  }

  async revokeSkill(id: string, actor: ActorInfo): Promise<SkillServiceResult<{ skill: Skill }>> {
    return this.transitionActivation(id, "revoked", actor, true);
  }

  // ─────────────────────────────────────
  // Content update (with re-review)
  // ─────────────────────────────────────

  async updateSkillContent(
    id: string,
    data: Omit<
      Skill,
      | "id"
      | "tenantId"
      | "trustState"
      | "activationState"
      | "contentHash"
      | "createdAt"
      | "updatedAt"
    >,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ skill: Skill }>> {
    const skill = await this.skills.getById(id);
    if (!skill) {
      return { ok: false, reason: "not_found", message: "Skill not found" };
    }

    if (!isContentMutable(skill.trustState)) {
      return {
        ok: false,
        reason: "immutable_version",
        message: `Contenu immutable dans l'état ${skill.trustState}. Créez une nouvelle version.`,
      };
    }

    const now = new Date().toISOString();
    const previousHash = skill.contentHash;

    const updatedPartial: Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt"> = {
      ...data,
      trustState: "untrusted",
      activationState: "inactive",
      contentHash: "",
      provenance: skill.provenance,
    };

    const newHash = computeSkillHash(updatedPartial);
    const finalUpdated = await this.skills.updateContent(id, {
      ...updatedPartial,
      contentHash: newHash,
    });

    if (!finalUpdated) {
      return { ok: false, reason: "update_failed", message: "Échec de mise à jour du contenu" };
    }

    // Audit
    await this.audit.append({
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.content_changed",
      actor: { kind: actor.actorKind, id: actor.actorLabel },
      details: {
        skillKey: skill.skillKey,
        version: skill.version,
        previousHash,
        newHash,
      },
    });

    return { ok: true, data: { skill: finalUpdated } };
  }

  // ─────────────────────────────────────
  // Scans & Evaluations
  // ─────────────────────────────────────

  async recordScan(
    scan: Omit<SecurityScan, "createdAt">,
    findings: Array<Omit<import("@/core/contracts/skill").SecurityFinding, "createdAt">>,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ scan: SecurityScan }>> {
    const now = new Date().toISOString();
    const fullScan: SecurityScan = {
      ...scan,
      id: scan.id || randomUUID(),
      createdAt: now,
    };

    const created = await this.scans.create(fullScan);

    await this.audit.append({
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.security_scan_recorded",
      actor: { kind: actor.actorKind, id: actor.actorLabel },
      details: {
        skillId: created.skillId,
        scanId: created.id,
        evaluatedHash: created.evaluatedContentHash,
        status: created.status,
        findingsCount: findings.length,
      },
    });

    return { ok: true, data: { scan: created } };
  }

  async recordEval(
    evalRecord: Omit<Evaluation, "createdAt">,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ eval: Evaluation }>> {
    const now = new Date().toISOString();
    const fullEval: Evaluation = {
      ...evalRecord,
      id: evalRecord.id || randomUUID(),
      createdAt: now,
    };

    const created = await this.evals.create(fullEval);

    await this.audit.append({
      id: randomUUID(),
      occurredAt: now,
      eventType: "skill.eval_recorded",
      actor: { kind: actor.actorKind, id: actor.actorLabel },
      details: {
        skillId: created.skillId,
        evalId: created.id,
        evaluatedHash: created.evaluatedContentHash,
        status: created.status,
      },
    });

    return { ok: true, data: { eval: created } };
  }

  // ─────────────────────────────────────
  // Lecture
  // ─────────────────────────────────────

  async getSkill(id: string): Promise<SkillServiceResult<{ skill: Skill }>> {
    const skill = await this.skills.getById(id);
    if (!skill) {
      return { ok: false, reason: "not_found", message: "Skill not found" };
    }
    return { ok: true, data: { skill } };
  }

  async listSkills(
    tenantId: string,
    filters?: SkillListFilters,
  ): Promise<SkillServiceResult<{ skills: Skill[] }>> {
    const result = await this.skills.list(tenantId, filters);
    return { ok: true, data: { skills: result } };
  }

  async deleteSkill(
    id: string,
    actor: ActorInfo,
  ): Promise<SkillServiceResult<{ deleted: boolean }>> {
    const skill = await this.skills.getById(id);
    if (!skill) {
      return { ok: false, reason: "not_found", message: "Skill not found" };
    }
    if (skill.activationState === "active") {
      return {
        ok: false,
        reason: "cannot_delete_active",
        message: "Impossible de supprimer un skill actif",
      };
    }

    const deleted = await this.skills.delete(id);
    return { ok: true, data: { deleted } };
  }
}
