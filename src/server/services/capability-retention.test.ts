import { afterEach, describe, expect, it } from "vitest";

import { resetContainer, buildMemoryContainer } from "@/server/container";
import { CapabilityService, type CreateCapabilityInput } from "./capability-service";

async function createService() {
  const container = buildMemoryContainer();
  return {
    service: new CapabilityService(
      container.capabilities,
      container.agentCapabilities,
      container.capabilityUow,
    ),
  };
}

describe("C3 retention gate — CapabilityService", () => {
  afterEach(async () => {
    await resetContainer();
  });

  it("CT-AUTO-01: active une capability C0 sans retention → accepté", async () => {
    const { service } = await createService();
    const created = await service.createCapability({
      key: "c0.test",
      name: "C0 Test",
      category: "cognitive",
      actorLabel: "test-user",
      sensitivityLevel: "C0",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const activated = await service.changeCapabilityStatus({
      capabilityId: created.data.id,
      targetStatus: "active",
      actorLabel: "test-user",
    });
    expect(activated.ok).toBe(true);
  });

  it("CT-AUTO-02: active une capability C3 avec retention → accepté", async () => {
    const { service } = await createService();
    const created = await service.createCapability({
      key: "c3.test.withretention",
      name: "C3 With Retention",
      category: "cognitive",
      actorLabel: "test-user",
      sensitivityLevel: "C3",
      retentionPolicyRef: {
        maxRetentionDays: 90,
        legalBasis: "consent",
        purpose: "Test retention gate",
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const activated = await service.changeCapabilityStatus({
      capabilityId: created.data.id,
      targetStatus: "active",
      actorLabel: "test-user",
    });
    expect(activated.ok).toBe(true);
  });

  it("CT-AUTO-03: active une capability C3 SANS retention → refuse", async () => {
    const { service } = await createService();
    const created = await service.createCapability({
      key: "c3.test.noretention",
      name: "C3 No Retention",
      category: "cognitive",
      actorLabel: "test-user",
      sensitivityLevel: "C3",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const activated = await service.changeCapabilityStatus({
      capabilityId: created.data.id,
      targetStatus: "active",
      actorLabel: "test-user",
    });
    expect(activated.ok).toBe(false);
    if (!activated.ok) {
      expect(activated.reason).toBe("retention_policy_required");
    }
  });

  it("CT-AUTO-04: déprécier puis retirer une capability C3 avec retention → accepté (seule l'activation sans retention est bloquée)", async () => {
    const { service } = await createService();
    const created = await service.createCapability({
      key: "c3.test.deprecate",
      name: "C3 Deprecate Test",
      category: "cognitive",
      actorLabel: "test-user",
      sensitivityLevel: "C3",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Activer avec retention
    const activated = await service.changeCapabilityStatus({
      capabilityId: created.data.id,
      targetStatus: "active",
      actorLabel: "test-user",
    });
    expect(activated.ok).toBe(false); // C3 sans retention refusé
    if (activated.ok) return;

    // Créer une version avec retention
    const created2 = await service.createCapability({
      key: "c3.test.deprecate2",
      name: "C3 Deprecate Test 2",
      category: "cognitive",
      actorLabel: "test-user",
      sensitivityLevel: "C3",
      retentionPolicyRef: { maxRetentionDays: 90, legalBasis: "consent", purpose: "Test" },
    });
    expect(created2.ok).toBe(true);
    if (!created2.ok) return;

    // Activer (la retention est présente → OK)
    const activated2 = await service.changeCapabilityStatus({
      capabilityId: created2.data.id,
      targetStatus: "active",
      actorLabel: "test-user",
    });
    expect(activated2.ok).toBe(true);

    // Déprécier → OK
    const deprecated = await service.changeCapabilityStatus({
      capabilityId: created2.data.id,
      targetStatus: "deprecated",
      actorLabel: "test-user",
    });
    expect(deprecated.ok).toBe(true);

    // Retirer → OK
    const retired = await service.changeCapabilityStatus({
      capabilityId: created2.data.id,
      targetStatus: "retired",
      actorLabel: "test-user",
    });
    expect(retired.ok).toBe(true);
  });

  it("active une capability C2 sans retention → accepté", async () => {
    const { service } = await createService();
    const created = await service.createCapability({
      key: "c2.test",
      name: "C2 Test",
      category: "cognitive",
      actorLabel: "test-user",
      sensitivityLevel: "C2",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const activated = await service.changeCapabilityStatus({
      capabilityId: created.data.id,
      targetStatus: "active",
      actorLabel: "test-user",
    });
    expect(activated.ok).toBe(true);
  });
});
