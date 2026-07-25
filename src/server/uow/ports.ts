import type { AgentAction, Approval, AuditEntry } from "@/core/contracts";
import type { AgentCapability, Capability, CapabilityStatus } from "@/core/contracts/capability";
import type { HumanAgentLink, HumanAgentRelation, Role, UserStatus } from "@/core/identity";
import type { AdminHumanUser } from "@/server/repositories/ports";
import type { Skill } from "@/core/contracts/skill";

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

export type HumanAdministrationFailureReason =
  "not_found" | "already_exists" | "last_owner" | "audit_failed";

export type HumanAdministrationResult<T> =
  | {
      ok: true;
      value: T;
      changed: boolean;
    }
  | {
      ok: false;
      reason: HumanAdministrationFailureReason;
      message: string;
    };

export interface HumanAdministrationUnitOfWork {
  finalizeHumanCreation(input: {
    targetUserId: string;
    role: Role;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<AdminHumanUser>>;

  replaceRole(input: {
    targetUserId: string;
    nextRole: Role;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<AdminHumanUser>>;

  setStatus(input: {
    targetUserId: string;
    nextStatus: UserStatus;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<AdminHumanUser>>;

  createAgentLink(input: {
    id: string;
    targetUserId: string;
    agentId: string;
    relation: HumanAgentRelation;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<HumanAgentLink>>;

  removeAgentLink(input: {
    targetUserId: string;
    agentId: string;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<HumanAgentLink>>;
}

// --- Capability Unit of Work ---

export type CapabilityUowResult<T> =
  { ok: true; data: T } | { ok: false; reason: string; message: string };

/**
 * Unité de travail transactionnelle pour les opérations du Capability Registry.
 *
 * Chaque méthode applique, comme une opération logique unique, une mutation
 * métier et son entrée d'audit correspondante : soit l'ensemble réussit,
 * soit rien n'est appliqué.
 *
 * L'implémentation PostgreSQL utilise une transaction DB avec verrouillage
 * `FOR UPDATE` pour détecter les modifications concurrentes.
 *
 * L'implémentation mémoire garantit une section critique non interruptible
 * au sein d'une instance JavaScript (aucun `await` interne entre mutation et
 * audit). Elle NE garantit PAS la durabilité ni la cohérence multi-instances.
 */
export interface CapabilityUnitOfWork {
  createCapabilityWithAudit(input: {
    capability: Capability;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ capability: Capability }>>;

  changeStatusWithAudit(input: {
    id: string;
    expectedStatus: CapabilityStatus;
    targetStatus: CapabilityStatus;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ capability: Capability }>>;

  grantCapabilityWithAudit(input: {
    agentCapability: AgentCapability;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ id: string }>>;

  revokeCapabilityWithAudit(input: {
    id: string;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ revoked: boolean }>>;
}

// --- Skill Unit of Work (Lot C2) ---

export type SkillUowResult<T> =
  { ok: true; data: T } | { ok: false; reason: string; message: string };

/**
 * Unité de travail transactionnelle pour les mutations critiques du Skill Registry.
 */
export interface SkillUnitOfWork {
  /**
   * Active une skill version : désactive l'ancienne version active si elle existe,
   * active la nouvelle, audite les deux transitions.
   */
  activateVersionWithAudit(input: {
    skill: Skill;
    tenantId: string;
    skillKey: string;
    actorLabel: string;
    deactivationAudit: AuditEntry;
    activationAudit: AuditEntry;
  }): Promise<SkillUowResult<{ skill: Skill; deactivatedVersionId: string | null }>>;

  /**
   * Rejette atomiquement un skill : trustState=rejected, activationState=revoked.
   */
  rejectSkillWithAudit(input: {
    id: string;
    trustAudit: AuditEntry;
    activationAudit: AuditEntry;
  }): Promise<SkillUowResult<{ skill: Skill }>>;
}
