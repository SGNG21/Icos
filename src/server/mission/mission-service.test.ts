import { afterEach, describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryMissionRepository } from "./in-memory/mission-repository";
import { MissionService } from "./mission-service";
import type { Plan } from "@/core/mission";

async function createService() {
  const missions = new InMemoryMissionRepository();
  const auditLog = new InMemoryAuditLog();
  const audit = new InMemoryAuditRepository(auditLog);
  return {
    service: new MissionService(missions, audit),  // pas d'UoW pour les tests unitaires
    missions,
    audit,
  };
}

async function createTestMission(service: MissionService, userRequest = "Test request") {
  return service.createMission({
    userRequest,
    tenantId: "default",
  });
}

const testPlan: Plan = {
  steps: [
    { id: "step-1", description: "Analyse", dependsOn: [], status: "pending" },
    { id: "step-2", description: "Exécution", dependsOn: ["step-1"], status: "pending" },
  ],
  totalSteps: 2,
  description: "Test plan",
};

// ─────────────────────────────────────
// CREATE
// ─────────────────────────────────────

describe("D2 — createMission", () => {
  it("crée une mission avec status CREATED", async () => {
    const { service } = await createService();
    const result = await service.createMission({
      userRequest: "Analyse le projet",
      tenantId: "default",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("CREATED");
      expect(result.data.tenantId).toBe("default");
      expect(result.data.userRequest).toBe("Analyse le projet");
    }
  });

  it("audit la création", async () => {
    const { service, audit } = await createService();
    await service.createMission({ userRequest: "Test", tenantId: "default" });
    const entries = await audit.list();
    expect(entries.some((e) => e.eventType === "mission.created")).toBe(true);
  });
});

// ─────────────────────────────────────
// TRANSITIONS — happy path
// ─────────────────────────────────────

describe("D2 — transitionStatus (succès)", () => {
  it("CREATED → PLANNING → PLANNED → IN_PROGRESS → COMPLETED", async () => {
    const { service } = await createService();

    // CREATED → PLANNING
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const r1 = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "PLANNING",
      actorLabel: "system",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.status).toBe("PLANNING");

    // PLANNING → PLANNED
    const r2a = await service.setPlan({
      missionId: created.data.id,
      plan: testPlan,
      actorLabel: "system",
    });
    expect(r2a.ok).toBe(true);
    if (!r2a.ok) return;
    expect(r2a.data.status).toBe("PLANNED");

    // PLANNED → IN_PROGRESS
    const r2 = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "IN_PROGRESS",
      actorLabel: "system",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.status).toBe("IN_PROGRESS");

    // IN_PROGRESS → COMPLETED
    const r3 = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "COMPLETED",
      actorLabel: "system",
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.data.status).toBe("COMPLETED");
    expect(r3.data.completedAt).toBeDefined();
  });

  it("IN_PROGRESS → WAITING_FOR_APPROVAL → IN_PROGRESS → COMPLETED", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // CREATED → PLANNING
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    // PLANNING → PLANNED (via setPlan)
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });
    // PLANNED → IN_PROGRESS
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });

    // IN_PROGRESS → WAITING_FOR_APPROVAL
    const r = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "WAITING_FOR_APPROVAL",
      actorLabel: "human",
      reason: "Action sensible",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe("WAITING_FOR_APPROVAL");

    // WAITING_FOR_APPROVAL → IN_PROGRESS
    const r2 = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "IN_PROGRESS",
      actorLabel: "human",
      approvedBy: "user-1",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.status).toBe("IN_PROGRESS");

    // IN_PROGRESS → COMPLETED
    const r3 = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "COMPLETED",
      actorLabel: "system",
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.data.status).toBe("COMPLETED");
  });

  it("IN_PROGRESS → TOOL_FAILED → IN_PROGRESS → COMPLETED", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });

    const r = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "TOOL_FAILED",
      actorLabel: "system",
      reason: "Tool timeout",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe("TOOL_FAILED");

    const r2 = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "IN_PROGRESS",
      actorLabel: "system",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.status).toBe("IN_PROGRESS");
  });

  it("IN_PROGRESS → PROVIDER_UNAVAILABLE → IN_PROGRESS → COMPLETED", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PROVIDER_UNAVAILABLE", actorLabel: "system", reason: "OpenAI down" });
    const r2 = await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.status).toBe("IN_PROGRESS");
  });

  it("IN_PROGRESS → SKILL_REVOKED → FAILED (irrécouvrable)", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "SKILL_REVOKED", actorLabel: "system" });
    const r2 = await service.transitionStatus({ missionId: created.data.id, targetStatus: "FAILED", actorLabel: "system" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.status).toBe("FAILED");
    expect(r2.data.completedAt).toBeDefined();
  });
});

// ─────────────────────────────────────
// TRANSITIONS — refus
// ─────────────────────────────────────

describe("D2 — transitionStatus (refus)", () => {
  it("transition invalide → refus", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // CREATED → COMPLETED n'est pas valide
    const r = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "COMPLETED",
      actorLabel: "system",
    });
    expect(r.ok).toBe(false);
  });

  it("mission terminée ne peut pas transitionner", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "COMPLETED", actorLabel: "system" });

    const r = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "IN_PROGRESS",
      actorLabel: "system",
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toBe("terminal");
  });

  it("mission inconnue → refus", async () => {
    const { service } = await createService();
    const r = await service.transitionStatus({
      missionId: "nonexistent",
      targetStatus: "COMPLETED",
      actorLabel: "system",
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toBe("not_found");
  });

  it("PLANNED → CANCELLED", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });

    const r = await service.transitionStatus({
      missionId: created.data.id,
      targetStatus: "CANCELLED",
      actorLabel: "human",
      reason: "Plus nécessaire",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe("CANCELLED");
  });
});

// ─────────────────────────────────────
// GET / FIND
// ─────────────────────────────────────

describe("D2 — get missions", () => {
  it("getMission retourne null si inexistant", async () => {
    const { service } = await createService();
    const m = await service.getMission("nonexistent");
    expect(m).toBeNull();
  });

  it("getActiveMissions ignore les missions terminées", async () => {
    const { service } = await createService();
    const m1 = await createTestMission(service);
    const m2 = await createTestMission(service);
    expect(m1.ok).toBe(true);
    expect(m2.ok).toBe(true);
    if (!m1.ok || !m2.ok) return;

    await service.transitionStatus({ missionId: m1.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: m1.data.id, plan: testPlan, actorLabel: "system" });
    await service.transitionStatus({ missionId: m1.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });
    await service.transitionStatus({ missionId: m1.data.id, targetStatus: "COMPLETED", actorLabel: "system" });

    const actives = await service.getActiveMissions();
    expect(actives.length).toBe(1);
    expect(actives[0].id).toBe(m2.data.id);
  });
});

// ─────────────────────────────────────
// RUNS
// ─────────────────────────────────────

describe("D2 — addRun", () => {
  it("ajoute un run à une mission planifiée", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });

    const run = await service.addRun({ missionId: created.data.id, stepIndex: 0 });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.data.status).toBe("in_progress");
    expect(run.data.missionId).toBe(created.data.id);

    const mission = await service.getMission(created.data.id);
    expect(mission).not.toBeNull();
    expect(mission!.runs.length).toBe(1);
    expect(mission!.currentRunId).toBe(run.data.id);
  });

  it("stepIndex invalide → refus", async () => {
    const { service } = await createService();
    const created = await createTestMission(service);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await service.transitionStatus({ missionId: created.data.id, targetStatus: "PLANNING", actorLabel: "system" });
    await service.setPlan({ missionId: created.data.id, plan: testPlan, actorLabel: "system" });
    await service.transitionStatus({ missionId: created.data.id, targetStatus: "IN_PROGRESS", actorLabel: "system" });

    const run = await service.addRun({ missionId: created.data.id, stepIndex: 99 });
    expect(run.ok).toBe(false);
    expect(run.ok ? "" : run.reason).toBe("invalid_step");
  });
});
