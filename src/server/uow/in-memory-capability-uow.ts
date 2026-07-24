import type { AuditEntry, Capability, AgentCapability, CapabilityStatus } from "@/core/contracts";
import { RepositoryMappingError } from "@/server/database/errors";
import { InMemoryAgentCapabilityRepository } from "@/server/services/in-memory/agent-capability-repository";
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";

import type { CapabilityUnitOfWork, CapabilityUowResult } from "./ports";

/**
 * Unité de travail EN MÉMOIRE pour les opérations du Capability Registry.
 *
 * Chaque méthode de mutation et son audit s'exécutent en section critique
 * synchrone (aucun `await` entre la mutation et l'audit), garantissant
 * l'atomicité au sein d'une instance JavaScript.
 *
 * PORTÉE DE LA GARANTIE : atomicité intra-processus uniquement. Ne garantit
 * PAS la durabilité ni la cohérence multi-instances. Ces propriétés viendront
 * de la transaction PostgreSQL.
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
    try {
      await this.capabilities.create(input.capability);
      this.auditLog.append(input.auditEntry);
      return { ok: true, data: { capability: input.capability } };
    } catch (error) {
      return {
        ok: false,
        reason: "creation_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async changeStatusWithAudit(input: {
    id: string;
    expectedStatus: CapabilityStatus;
    targetStatus: CapabilityStatus;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ capability: Capability }>> {
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

    const updated = await this.capabilities.updateStatus(input.id, input.targetStatus);
    if (updated === null) {
      return {
        ok: false,
        reason: "not_found",
        message: "Capacité introuvable lors de la mise à jour",
      };
    }

    this.auditLog.append(input.auditEntry);
    return { ok: true, data: { capability: updated } };
  }

  async grantCapabilityWithAudit(input: {
    agentCapability: AgentCapability;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ id: string }>> {
    try {
      await this.agentCapabilities.grant(input.agentCapability);
      this.auditLog.append(input.auditEntry);
      return { ok: true, data: { id: input.agentCapability.id } };
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
  }

  async revokeCapabilityWithAudit(input: {
    id: string;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ revoked: boolean }>> {
    const revoked = await this.agentCapabilities.revoke(input.id);
    if (!revoked) {
      return { ok: false, reason: "not_found", message: "Assignation introuvable" };
    }
    this.auditLog.append(input.auditEntry);
    return { ok: true, data: { revoked: true } };
  }
}
