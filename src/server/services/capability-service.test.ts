import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";
import type { AuditLog, AuditQuery } from "@/server/audit/in-memory-audit-log";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryAgentCapabilityRepository } from "@/server/services/in-memory/agent-capability-repository";
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";
import { InMemoryCapabilityUnitOfWork } from "@/server/uow/in-memory-capability-uow";

import { CapabilityService } from "./capability-service";

function createService() {
  const capabilities = new InMemoryCapabilityRepository();
  const agentCapabilities = new InMemoryAgentCapabilityRepository();
  const auditLog = new InMemoryAuditLog();
  const audit = new InMemoryAuditRepository(auditLog);
  const uow = new InMemoryCapabilityUnitOfWork(capabilities, agentCapabilities, auditLog);
  const service = new CapabilityService(capabilities, agentCapabilities, uow);
  return { capabilities, agentCapabilities, audit, auditLog, service };
}

describe("CapabilityService", () => {
  describe("createCapability", () => {
    it("crée une capacité avec status proposed", async () => {
      const { service } = createService();
      const result = await service.createCapability({
        key: "code.review",
        name: "Code Review",
        category: "code",
        actorLabel: "human-admin",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe("proposed");
        expect(result.data.key).toBe("code.review");
        expect(result.data.id).toMatch(/^cap-/);
      }
    });

    it("écrit un événement d'audit capability.created", async () => {
      const { service, auditLog } = createService();
      await service.createCapability({
        key: "code.review",
        name: "Code Review",
        category: "code",
        actorLabel: "human-admin",
      });
      const events = auditLog.query({ eventType: "capability.created" });
      expect(events).toHaveLength(1);
      expect(events[0].actor.id).toBe("human-admin");
    });

    it("rejette un key dupliqué", async () => {
      const { service } = createService();
      await service.createCapability({
        key: "unique.key",
        name: "First",
        category: "code",
        actorLabel: "admin",
      });
      const result = await service.createCapability({
        key: "unique.key",
        name: "Second",
        category: "code",
        actorLabel: "admin",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("changeCapabilityStatus", () => {
    it("effectue une transition valide et l'audite", async () => {
      const { service, auditLog } = createService();
      const created = await service.createCapability({
        key: "code.review",
        name: "Code Review",
        category: "code",
        actorLabel: "admin",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await service.changeCapabilityStatus({
        capabilityId: created.data.id,
        targetStatus: "active",
        actorLabel: "admin",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe("active");
      }
      const events = auditLog.query({ eventType: "capability.status_changed" });
      expect(events).toHaveLength(1);
    });

    it("refuse une transition interdite", async () => {
      const { service } = createService();
      const created = await service.createCapability({
        key: "direct.active",
        name: "Direct Active",
        category: "code",
        actorLabel: "admin",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await service.changeCapabilityStatus({
        capabilityId: created.data.id,
        targetStatus: "retired",
        actorLabel: "admin",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_transition");
      }
    });

    it("retourne not_found pour une capacité inconnue", async () => {
      const { service } = createService();
      const result = await service.changeCapabilityStatus({
        capabilityId: "cap-unknown",
        targetStatus: "active",
        actorLabel: "admin",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not_found");
      }
    });

    it("détecte une modification concurrente sur le statut", async () => {
      const { capabilities, service } = createService();
      const created = await service.createCapability({
        key: "concurrent.test",
        name: "Concurrent Test",
        category: "code",
        actorLabel: "admin",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Change status via service1 → proposed → active
      await service.changeCapabilityStatus({
        capabilityId: created.data.id,
        targetStatus: "active",
        actorLabel: "admin",
      });

      // Crée un service2 partageant les mêmes repositories et un expectedStatus
      // obsolète ("proposed") via un appel direct au UoW.
      const agentCapabilities = new InMemoryAgentCapabilityRepository();
      const auditLog = new InMemoryAuditLog();
      const uow = new InMemoryCapabilityUnitOfWork(capabilities, agentCapabilities, auditLog);

      const result = await uow.changeStatusWithAudit({
        id: created.data.id,
        expectedStatus: "proposed",
        targetStatus: "deprecated",
        auditEntry: {
          id: "audit-concurrent",
          occurredAt: new Date().toISOString(),
          eventType: "capability.status_changed",
          actor: { kind: "human", id: "admin" },
          details: { capabilityId: created.data.id, from: "proposed", to: "deprecated" },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("concurrent_modification");
      }
    });
  });

  describe("grantCapability", () => {
    it("assigne une capacité et l'audite", async () => {
      const { service, auditLog } = createService();
      // Seed: create capability and assume agent exists
      const cap = await service.createCapability({
        key: "code.write",
        name: "Code Write",
        category: "code",
        actorLabel: "admin",
      });
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;

      const result = await service.grantCapability({
        agentId: "agent-cto",
        capabilityId: cap.data.id,
        assignedByUserId: "user-1",
        actorLabel: "admin",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toMatch(/^ac-/);
      }
      const events = auditLog.query({ eventType: "agent_capability.granted" });
      expect(events).toHaveLength(1);
    });

    it("rejette un doublon agent_id + capability_id", async () => {
      const { service } = createService();
      const cap = await service.createCapability({
        key: "code.write",
        name: "Code Write",
        category: "code",
        actorLabel: "admin",
      });
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;

      await service.grantCapability({
        agentId: "agent-1",
        capabilityId: cap.data.id,
        assignedByUserId: "user-1",
        actorLabel: "admin",
      });
      const result = await service.grantCapability({
        agentId: "agent-1",
        capabilityId: cap.data.id,
        assignedByUserId: "user-1",
        actorLabel: "admin",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("revokeCapability", () => {
    it("révoque une capacité et l'audite", async () => {
      const { service, auditLog } = createService();
      const cap = await service.createCapability({
        key: "code.write",
        name: "Code Write",
        category: "code",
        actorLabel: "admin",
      });
      expect(cap.ok).toBe(true);
      if (!cap.ok) return;

      const granted = await service.grantCapability({
        agentId: "agent-1",
        capabilityId: cap.data.id,
        assignedByUserId: "user-1",
        actorLabel: "admin",
      });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;

      const result = await service.revokeCapability({
        agentCapabilityId: granted.data.id,
        actorLabel: "admin",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.revoked).toBe(true);
      }
      const events = auditLog.query({ eventType: "agent_capability.revoked" });
      expect(events).toHaveLength(1);
    });

    it("retourne not_found pour une assignation inconnue", async () => {
      const { service } = createService();
      const result = await service.revokeCapability({
        agentCapabilityId: "ac-unknown",
        actorLabel: "admin",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not_found");
      }
    });
  });
});

// --- Tests d'atomicité InMemoryCapabilityUnitOfWork ---

class BrokenAuditLog implements AuditLog {
  append(): AuditEntry {
    throw new Error("audit failure simulé");
  }
  appendMany(): readonly AuditEntry[] {
    throw new Error("audit failure");
  }
  list(): readonly AuditEntry[] {
    return [];
  }
  query(_filter: AuditQuery): readonly AuditEntry[] {
    return [];
  }
}

describe("InMemoryCapabilityUnitOfWork atomicité", () => {
  describe("create rollback", () => {
    it("annule la création en cas d'échec d'audit", async () => {
      const capabilities = new InMemoryCapabilityRepository();
      const agentCapabilities = new InMemoryAgentCapabilityRepository();
      const uow = new InMemoryCapabilityUnitOfWork(
        capabilities,
        agentCapabilities,
        new BrokenAuditLog(),
      );

      const result = await uow.createCapabilityWithAudit({
        capability: {
          id: "cap-rollback",
          key: "rollback.test",
          name: "Rollback Test",
          category: "test",
          status: "proposed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        auditEntry: {
          id: "audit-rollback",
          occurredAt: new Date().toISOString(),
          eventType: "capability.created",
          actor: { kind: "human", id: "admin" },
          details: {},
        },
      });

      expect(result.ok).toBe(false);
      // La capacité ne doit pas exister dans le repository
      expect(await capabilities.getById("cap-rollback")).toBeNull();
    });
  });

  describe("changeStatus rollback", () => {
    it("rétablit le statut antérieur en cas d'échec d'audit", async () => {
      const capabilities = new InMemoryCapabilityRepository();
      const agentCapabilities = new InMemoryAgentCapabilityRepository();
      // UoW normal pour créer la capacité
      const normalUow = new InMemoryCapabilityUnitOfWork(
        capabilities,
        agentCapabilities,
        new InMemoryAuditLog(),
      );
      const created = await normalUow.createCapabilityWithAudit({
        capability: {
          id: "cap-status-rollback",
          key: "status.rollback",
          name: "Status Rollback",
          category: "test",
          status: "proposed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        auditEntry: {
          id: "audit-create-status-rb",
          occurredAt: new Date().toISOString(),
          eventType: "capability.created",
          actor: { kind: "human", id: "admin" },
          details: {},
        },
      });
      expect(created.ok).toBe(true);

      // UoW cassé pour le changement de statut
      const brokenUow = new InMemoryCapabilityUnitOfWork(
        capabilities,
        agentCapabilities,
        new BrokenAuditLog(),
      );
      const result = await brokenUow.changeStatusWithAudit({
        id: "cap-status-rollback",
        expectedStatus: "proposed",
        targetStatus: "active",
        auditEntry: {
          id: "audit-status-rb",
          occurredAt: new Date().toISOString(),
          eventType: "capability.status_changed",
          actor: { kind: "human", id: "admin" },
          details: { capabilityId: "cap-status-rollback", from: "proposed", to: "active" },
        },
      });

      expect(result.ok).toBe(false);
      // Le statut doit être resté "proposed"
      const cap = await capabilities.getById("cap-status-rollback");
      expect(cap).not.toBeNull();
      expect(cap!.status).toBe("proposed");
    });
  });

  describe("grant rollback", () => {
    it("annule l'octroi en cas d'échec d'audit", async () => {
      const capabilities = new InMemoryCapabilityRepository();
      const agentCapabilities = new InMemoryAgentCapabilityRepository();
      const normalUow = new InMemoryCapabilityUnitOfWork(
        capabilities,
        agentCapabilities,
        new InMemoryAuditLog(),
      );
      const created = await normalUow.createCapabilityWithAudit({
        capability: {
          id: "cap-grant-rb",
          key: "grant.rollback",
          name: "Grant Rollback",
          category: "test",
          status: "proposed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        auditEntry: {
          id: "audit-create-grant-rb",
          occurredAt: new Date().toISOString(),
          eventType: "capability.created",
          actor: { kind: "human", id: "admin" },
          details: {},
        },
      });
      expect(created.ok).toBe(true);

      const brokenUow = new InMemoryCapabilityUnitOfWork(
        capabilities,
        agentCapabilities,
        new BrokenAuditLog(),
      );
      const result = await brokenUow.grantCapabilityWithAudit({
        agentCapability: {
          id: "ac-grant-rb",
          agentId: "agent-1",
          capabilityId: "cap-grant-rb",
          assignedAt: new Date().toISOString(),
          assignedByUserId: "user-1",
        },
        auditEntry: {
          id: "audit-grant-rb",
          occurredAt: new Date().toISOString(),
          eventType: "agent_capability.granted",
          actor: { kind: "human", id: "admin" },
          details: { agentId: "agent-1", capabilityId: "cap-grant-rb", assignedByUserId: "user-1" },
        },
      });

      expect(result.ok).toBe(false);
      // L'assignation ne doit pas exister
      expect(await agentCapabilities.getById("ac-grant-rb")).toBeNull();
    });
  });

  describe("revoke rollback", () => {
    it("rétablit l'assignation en cas d'échec d'audit", async () => {
      const capabilities = new InMemoryCapabilityRepository();
      const agentCapabilities = new InMemoryAgentCapabilityRepository();
      const normalUow = new InMemoryCapabilityUnitOfWork(
        capabilities,
        agentCapabilities,
        new InMemoryAuditLog(),
      );
      const created = await normalUow.createCapabilityWithAudit({
        capability: {
          id: "cap-revoke-rb",
          key: "revoke.rollback",
          name: "Revoke Rollback",
          category: "test",
          status: "proposed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        auditEntry: {
          id: "audit-create-revoke-rb",
          occurredAt: new Date().toISOString(),
          eventType: "capability.created",
          actor: { kind: "human", id: "admin" },
          details: {},
        },
      });
      expect(created.ok).toBe(true);

      const granted = await normalUow.grantCapabilityWithAudit({
        agentCapability: {
          id: "ac-revoke-rb",
          agentId: "agent-1",
          capabilityId: "cap-revoke-rb",
          assignedAt: new Date().toISOString(),
          assignedByUserId: "user-1",
        },
        auditEntry: {
          id: "audit-grant-revoke-rb",
          occurredAt: new Date().toISOString(),
          eventType: "agent_capability.granted",
          actor: { kind: "human", id: "admin" },
          details: {
            agentId: "agent-1",
            capabilityId: "cap-revoke-rb",
            assignedByUserId: "user-1",
          },
        },
      });
      expect(granted.ok).toBe(true);

      const brokenUow = new InMemoryCapabilityUnitOfWork(
        capabilities,
        agentCapabilities,
        new BrokenAuditLog(),
      );
      const result = await brokenUow.revokeCapabilityWithAudit({
        id: "ac-revoke-rb",
        auditEntry: {
          id: "audit-revoke-rb",
          occurredAt: new Date().toISOString(),
          eventType: "agent_capability.revoked",
          actor: { kind: "human", id: "admin" },
          details: {
            agentCapabilityId: "ac-revoke-rb",
            agentId: "agent-1",
            capabilityId: "cap-revoke-rb",
          },
        },
      });

      expect(result.ok).toBe(false);
      // L'assignation doit toujours exister
      expect(await agentCapabilities.getById("ac-revoke-rb")).not.toBeNull();
    });
  });
});
