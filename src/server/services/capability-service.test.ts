import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryAgentCapabilityRepository } from "@/server/services/in-memory/agent-capability-repository";
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";

import { CapabilityService } from "./capability-service";

function createService() {
  const capabilities = new InMemoryCapabilityRepository();
  const agentCapabilities = new InMemoryAgentCapabilityRepository();
  const auditLog = new InMemoryAuditLog();
  const audit = new InMemoryAuditRepository(auditLog);
  const service = new CapabilityService(capabilities, agentCapabilities, audit);
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
