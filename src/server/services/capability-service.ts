import { randomUUID } from "node:crypto";

import type { AuditEntry } from "@/core/contracts";
import type { Capability, CapabilityStatus } from "@/core/contracts/capability";
import { isTransitionAllowed } from "@/core/capabilities/lifecycle";
import type { CapabilityRepository, AgentCapabilityRepository } from "@/server/repositories/capability-ports";
import type { AuditRepository } from "@/server/repositories/ports";

export interface CreateCapabilityInput {
  key: string;
  name: string;
  description?: string;
  category: string;
  provenance?: Record<string, string>;
  riskHint?: string;
  actorLabel: string;
}

export interface ChangeStatusInput {
  capabilityId: string;
  targetStatus: CapabilityStatus;
  actorLabel: string;
}

export interface GrantCapabilityInput {
  agentId: string;
  capabilityId: string;
  assignedByUserId: string;
  actorLabel: string;
}

export interface RevokeCapabilityInput {
  agentCapabilityId: string;
  actorLabel: string;
}

export type CapabilityServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; message: string };

export class CapabilityService {
  constructor(
    private readonly capabilities: CapabilityRepository,
    private readonly agentCapabilities: AgentCapabilityRepository,
    private readonly audit: AuditRepository,
  ) {}

  async createCapability(input: CreateCapabilityInput): Promise<CapabilityServiceResult<Capability>> {
    const now = new Date().toISOString();
    const capability: Capability = {
      id: `cap-${randomUUID()}`,
      key: input.key,
      name: input.name,
      description: input.description,
      category: input.category,
      status: "proposed",
      provenance: input.provenance,
      riskHint: input.riskHint,
      createdAt: now,
      updatedAt: now,
    };

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "capability.created",
      actor: { kind: "human", id: input.actorLabel },
      details: { key: input.key, name: input.name, category: input.category },
    };

    try {
      const created = await this.capabilities.create(capability);
      await this.audit.append(auditEntry);
      return { ok: true, data: created };
    } catch (error) {
      return {
        ok: false,
        reason: "creation_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async changeCapabilityStatus(input: ChangeStatusInput): Promise<CapabilityServiceResult<Capability>> {
    const existing = await this.capabilities.getById(input.capabilityId);
    if (existing === null) {
      return { ok: false, reason: "not_found", message: `Capability inconnue : ${input.capabilityId}` };
    }

    if (!isTransitionAllowed(existing.status, input.targetStatus)) {
      return {
        ok: false,
        reason: "invalid_transition",
        message: `Transition interdite : ${existing.status} → ${input.targetStatus}`,
      };
    }

    const now = new Date().toISOString();
    const updated = await this.capabilities.updateStatus(input.capabilityId, input.targetStatus);
    if (updated === null) {
      return { ok: false, reason: "not_found", message: `Capability inconnue : ${input.capabilityId}` };
    }

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "capability.status_changed",
      actor: { kind: "human", id: input.actorLabel },
      details: {
        capabilityId: input.capabilityId,
        from: existing.status,
        to: input.targetStatus,
      },
    };

    try {
      await this.audit.append(auditEntry);
      return { ok: true, data: updated };
    } catch (error) {
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async grantCapability(input: GrantCapabilityInput): Promise<CapabilityServiceResult<{ id: string }>> {
    const now = new Date().toISOString();
    const ac = {
      id: `ac-${randomUUID()}`,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      assignedAt: now,
      assignedByUserId: input.assignedByUserId,
    };

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "agent_capability.granted",
      actor: { kind: "human", id: input.actorLabel },
      details: {
        agentId: input.agentId,
        capabilityId: input.capabilityId,
        assignedByUserId: input.assignedByUserId,
      },
    };

    try {
      await this.agentCapabilities.grant(ac);
      await this.audit.append(auditEntry);
      return { ok: true, data: { id: ac.id } };
    } catch (error) {
      return {
        ok: false,
        reason: "grant_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async revokeCapability(input: RevokeCapabilityInput): Promise<CapabilityServiceResult<{ revoked: boolean }>> {
    const existing = await this.agentCapabilities.getById(input.agentCapabilityId);
    if (existing === null) {
      return { ok: false, reason: "not_found", message: `AgentCapability inconnue : ${input.agentCapabilityId}` };
    }

    const now = new Date().toISOString();
    const revoked = await this.agentCapabilities.revoke(input.agentCapabilityId);

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "agent_capability.revoked",
      actor: { kind: "human", id: input.actorLabel },
      details: {
        agentCapabilityId: input.agentCapabilityId,
        agentId: existing.agentId,
        capabilityId: existing.capabilityId,
      },
    };

    try {
      await this.audit.append(auditEntry);
      return { ok: true, data: { revoked } };
    } catch (error) {
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
