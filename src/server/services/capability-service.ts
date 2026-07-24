import { randomUUID } from "node:crypto";

import type { AuditEntry, Capability, CapabilityStatus } from "@/core/contracts";
import { isTransitionAllowed } from "@/core/capabilities/lifecycle";
import type {
  CapabilityRepository,
  AgentCapabilityRepository,
} from "@/server/repositories/capability-ports";
import type { CapabilityUnitOfWork } from "@/server/uow/ports";

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
  { ok: true; data: T } | { ok: false; reason: string; message: string };

export class CapabilityService {
  constructor(
    private readonly capabilities: CapabilityRepository,
    private readonly agentCapabilities: AgentCapabilityRepository,
    private readonly uow: CapabilityUnitOfWork,
  ) {}

  async createCapability(
    input: CreateCapabilityInput,
  ): Promise<CapabilityServiceResult<Capability>> {
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

    const uowResult = await this.uow.createCapabilityWithAudit({ capability, auditEntry });
    if (!uowResult.ok) return uowResult;
    return { ok: true, data: uowResult.data.capability };
  }

  async changeCapabilityStatus(
    input: ChangeStatusInput,
  ): Promise<CapabilityServiceResult<Capability>> {
    const existing = await this.capabilities.getById(input.capabilityId);
    if (existing === null) {
      return {
        ok: false,
        reason: "not_found",
        message: `Capability inconnue : ${input.capabilityId}`,
      };
    }

    if (!isTransitionAllowed(existing.status, input.targetStatus)) {
      return {
        ok: false,
        reason: "invalid_transition",
        message: `Transition interdite : ${existing.status} → ${input.targetStatus}`,
      };
    }

    const now = new Date().toISOString();
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

    const uowResult = await this.uow.changeStatusWithAudit({
      id: input.capabilityId,
      expectedStatus: existing.status,
      targetStatus: input.targetStatus,
      auditEntry,
    });
    if (!uowResult.ok) return uowResult;
    return { ok: true, data: uowResult.data.capability };
  }

  async grantCapability(
    input: GrantCapabilityInput,
  ): Promise<CapabilityServiceResult<{ id: string }>> {
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

    return this.uow.grantCapabilityWithAudit({ agentCapability: ac, auditEntry });
  }

  async revokeCapability(
    input: RevokeCapabilityInput,
  ): Promise<CapabilityServiceResult<{ revoked: boolean }>> {
    const existing = await this.agentCapabilities.getById(input.agentCapabilityId);
    if (existing === null) {
      return {
        ok: false,
        reason: "not_found",
        message: `AgentCapability inconnue : ${input.agentCapabilityId}`,
      };
    }

    const now = new Date().toISOString();
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

    return this.uow.revokeCapabilityWithAudit({ id: input.agentCapabilityId, auditEntry });
  }
}
