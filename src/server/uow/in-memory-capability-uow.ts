import { auditEntrySchema } from "@/core/contracts";
import type { AuditEntry, Capability, AgentCapability, CapabilityStatus } from "@/core/contracts";
import { RepositoryMappingError } from "@/server/database/errors";
import { InMemoryAgentCapabilityRepository } from "@/server/services/in-memory/agent-capability-repository";
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";

import type { CapabilityUnitOfWork, CapabilityUowResult } from "./ports";

/**
 * Unité de travail EN MÉMOIRE pour les opérations du Capability Registry.
 *
 * Chaque méthode garantit l'atomicité via un pattern de pré-validation suivie
 * d'une section critique avec restauration sur échec :
 *
 *   1. validation préalable de l'entrée d'audit (échec → aucune mutation) ;
 *   2. capture de l'état pré-mutation (snapshot) ;
 *   3. mutation métier ;
 *   4. écriture d'audit ;
 *   5. si l'audit échoue → restauration de l'état pré-mutation.
 *
 * L'implémentation PostgreSQL parallèle garantit la même sémantique via
 * `db.transaction()` avec rollback automatique.
 */
export class InMemoryCapabilityUnitOfWork implements CapabilityUnitOfWork {
  constructor(
    private readonly capabilities: InMemoryCapabilityRepository,
    private readonly agentCapabilities: InMemoryAgentCapabilityRepository,
    private readonly auditLog: AuditLog,
  ) {}

  async createCapabilityWithAudit(input: {
    capability: Capability;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ capability: Capability }>> {
    // 1. Pré-validation de l'entrée d'audit (échec → aucune mutation)
    const auditValid = auditEntrySchema.safeParse(input.auditEntry);
    if (!auditValid.success) {
      return { ok: false, reason: "creation_failed", message: auditValid.error.message };
    }

    // 2. Mutation
    try {
      await this.capabilities.create(input.capability);
    } catch (error) {
      return {
        ok: false,
        reason: "creation_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // 3. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.capabilities.delete(input.capability.id).catch(() => {});
      return {
        ok: false,
        reason: "creation_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, data: { capability: input.capability } };
  }

  async changeStatusWithAudit(input: {
    id: string;
    expectedStatus: CapabilityStatus;
    targetStatus: CapabilityStatus;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ capability: Capability }>> {
    // 1. Pré-validation de l'entrée d'audit (échec → aucune mutation)
    const auditValid = auditEntrySchema.safeParse(input.auditEntry);
    if (!auditValid.success) {
      return { ok: false, reason: "concurrent_modification", message: auditValid.error.message };
    }

    // 2. Vérifications pré-mutation
    const existing = await this.capabilities.getById(input.id);
    if (existing === null) {
      return { ok: false, reason: "not_found", message: "Capacité introuvable" };
    }
    if (existing.status !== input.expectedStatus) {
      return {
        ok: false,
        reason: "concurrent_modification",
        message: `Statut modifié de manière concurrente : attendu ${input.expectedStatus}, réel ${existing.status}`,
      };
    }

    // 3. Mutation (snapshot du statut pré-mutation pour rollback)
    const previousStatus = existing.status;
    const updated = await this.capabilities.updateStatus(input.id, input.targetStatus);
    if (updated === null) {
      return {
        ok: false,
        reason: "not_found",
        message: "Capacité introuvable lors de la mise à jour",
      };
    }

    // 4. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.capabilities.updateStatus(input.id, previousStatus).catch(() => {});
      return {
        ok: false,
        reason: "concurrent_modification",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, data: { capability: updated } };
  }

  async grantCapabilityWithAudit(input: {
    agentCapability: AgentCapability;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ id: string }>> {
    // 1. Pré-validation de l'entrée d'audit (échec → aucune mutation)
    const auditValid = auditEntrySchema.safeParse(input.auditEntry);
    if (!auditValid.success) {
      return { ok: false, reason: "grant_failed", message: auditValid.error.message };
    }

    // 2. Mutation
    try {
      await this.agentCapabilities.grant(input.agentCapability);
    } catch (error) {
      if (error instanceof RepositoryMappingError) {
        return { ok: false, reason: "grant_failed", message: error.message };
      }
      return {
        ok: false,
        reason: "grant_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // 3. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.agentCapabilities.revoke(input.agentCapability.id).catch(() => {});
      return {
        ok: false,
        reason: "grant_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, data: { id: input.agentCapability.id } };
  }

  async revokeCapabilityWithAudit(input: {
    id: string;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ revoked: boolean }>> {
    // 1. Pré-validation de l'entrée d'audit (échec → aucune mutation)
    const auditValid = auditEntrySchema.safeParse(input.auditEntry);
    if (!auditValid.success) {
      return { ok: false, reason: "not_found", message: auditValid.error.message };
    }

    // 2. Snapshot de l'état pré-mutation pour rollback éventuel
    const existing = await this.agentCapabilities.getById(input.id);
    if (existing === null) {
      return { ok: false, reason: "not_found", message: "Assignation introuvable" };
    }

    // 3. Mutation
    const revoked = await this.agentCapabilities.revoke(input.id);
    if (!revoked) {
      return { ok: false, reason: "not_found", message: "Assignation introuvable" };
    }

    // 4. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.agentCapabilities.grant(existing).catch(() => {});
      return {
        ok: false,
        reason: "not_found",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, data: { revoked: true } };
  }
}
