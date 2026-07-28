import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildMissionContext,
  CONTEXT_LIMITS,
  resolveSupervisorContext,
  type SupervisorEnrichedContext,
} from "@/core/context";
import type { MissionResult } from "@/core/mission";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryMissionContextRepository } from "@/server/context/in-memory/mission-context-repository";
import type { MissionContextRepository } from "@/server/context/ports";
import { InMemoryMissionRepository } from "@/server/mission/in-memory/mission-repository";
import { MissionService } from "@/server/mission/mission-service";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";

import {
  createMissionFromUserRequest,
  type CreateMissionFromUserRequestDeps,
} from "./create-mission-from-user-request";

const TRUSTED = {
  tenantId: "tenant-user-mission",
  actorId: "human-user-123",
};

function harness() {
  const missions = new InMemoryMissionRepository();
  const audit = new InMemoryAuditRepository(new InMemoryAuditLog());
  const missionService = new MissionService(missions, audit);
  const missionContexts = new InMemoryMissionContextRepository();
  const save = vi.spyOn(missionContexts, "save");
  const buildContext = vi.fn(buildMissionContext);
  const resolveContext = vi.fn(resolveSupervisorContext);

  return {
    missions,
    missionContexts,
    save,
    buildContext,
    resolveContext,
    deps: {
      missionService,
      missionContexts,
      buildContext,
      resolveContext,
    } satisfies CreateMissionFromUserRequestDeps,
  };
}

describe("createMissionFromUserRequest — canonical success", () => {
  it("creates and returns the canonical D2 Mission in CREATED state", async () => {
    const h = harness();
    const createMission = vi.spyOn(h.deps.missionService, "createMission");
    const result = await createMissionFromUserRequest(
      h.deps,
      { objective: "Préparer le rapport trimestriel" },
      TRUSTED,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.missionId).toMatch(/^mission-[0-9a-f-]{36}$/);
    expect(result.missionState).toBe("CREATED");
    expect(result.createdAt).toBe(result.updatedAt);
    expect(Number.isNaN(Date.parse(result.createdAt))).toBe(false);

    const serviceResult = await createMission.mock.results[0]?.value;
    expect(serviceResult?.ok).toBe(true);
    if (serviceResult?.ok) {
      expect(result.missionId).toBe(serviceResult.data.id);
      expect(result.createdAt).toBe(serviceResult.data.createdAt);
      expect(result.updatedAt).toBe(serviceResult.data.updatedAt);
    }

    const storedMission = await h.missions.findById(result.missionId);
    expect(storedMission).toMatchObject({
      id: result.missionId,
      tenantId: TRUSTED.tenantId,
      userRequest: result.objective,
      status: result.missionState,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    });
  });

  it("preserves the exact objective in Mission and context, including valid whitespace", async () => {
    const h = harness();
    const objective = "  Préparer le rapport trimestriel  ";
    const result = await createMissionFromUserRequest(h.deps, { objective }, TRUSTED);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const storedMission = await h.missions.findById(result.missionId);
    const storedContext = await h.missionContexts.findLatest(TRUSTED.tenantId, result.missionId);
    expect(result.objective).toBe(objective);
    expect(storedMission?.userRequest).toBe(objective);
    expect(storedContext?.confirmedObjective).toBe(objective);
    expect(result.supervisorContext.input.confirmedObjective).toBe(objective);
  });

  it("uses trusted tenant and actor only, persists version 0, and invokes canonical context APIs", async () => {
    const h = harness();
    const result = await createMissionFromUserRequest(
      h.deps,
      { objective: "Documenter le flux utilisateur" },
      TRUSTED,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(h.buildContext).toHaveBeenCalledOnce();
    expect(h.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        builtByLabel: TRUSTED.actorId,
        version: 0,
        conversation: expect.objectContaining({ tenantId: TRUSTED.tenantId }),
      }),
    );
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: null }));
    expect(h.resolveContext).toHaveBeenCalledOnce();
    const bridgeResult = h.resolveContext.mock.results[0]?.value;
    expect(bridgeResult?.ok).toBe(true);
    if (bridgeResult?.ok) {
      expect(result.supervisorContext).toEqual(bridgeResult.envelope);
    }
    expect(result.contextRef).toMatchObject({
      tenantId: TRUSTED.tenantId,
      missionId: result.missionId,
      version: 0,
    });

    const storedContext = await h.missionContexts.findVersion(
      TRUSTED.tenantId,
      result.missionId,
      0,
    );
    expect(storedContext?.builtByLabel).toBe(TRUSTED.actorId);
    expect(storedContext?.confirmedConstraints).toEqual([]);
    expect(storedContext?.assumptions).toEqual([]);
    expect(storedContext?.openQuestions).toEqual([]);
    expect(storedContext?.memoryReferences).toEqual([]);
    expect(storedContext?.boundedSummary.length).toBeLessThanOrEqual(
      CONTEXT_LIMITS.summaryMaxLength,
    );
  });

  it("returns a deterministic, narrow shape consumable as the optional Supervisor context", async () => {
    const h = harness();
    const result = await createMissionFromUserRequest(
      h.deps,
      { objective: "Préparer une synthèse" },
      TRUSTED,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    type SupervisorContextArgument = Parameters<SupervisorService["execute"]>[1];
    const contextArgument: SupervisorContextArgument = result.supervisorContext;
    const consumeOptionalContext = (context?: SupervisorEnrichedContext): void => {
      void context;
    };
    consumeOptionalContext(contextArgument);

    expect(Object.keys(result)).toEqual([
      "ok",
      "missionId",
      "objective",
      "missionState",
      "createdAt",
      "updatedAt",
      "contextRef",
      "supervisorContext",
    ]);
    expect(Object.keys(result.supervisorContext.input)).toEqual([
      "tenantId",
      "missionId",
      "contextVersion",
      "confirmedObjective",
      "confirmedConstraints",
      "openQuestions",
      "boundedSummary",
      "memoryReferences",
    ]);
  });

  it.each(["Déployer la version en production", "Merger la branche après revue"])(
    "keeps operational wording as descriptive intent only: %s",
    async (objective) => {
      const h = harness();
      const result = await createMissionFromUserRequest(h.deps, { objective }, TRUSTED);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.objective).toBe(objective);
      expect(result.supervisorContext.input.confirmedObjective).toBe(objective);
      expect(result.supervisorContext.input).not.toHaveProperty("productionAccess");
      expect(result.supervisorContext.input).not.toHaveProperty("mergeAllowed");
      expect(result.supervisorContext.input).not.toHaveProperty("authorization");
    },
  );
});

describe("createMissionFromUserRequest — input boundary", () => {
  it.each([
    ["empty", ""],
    ["blank", " \n\t "],
    ["malformed", 42],
    ["over budget", "x".repeat(CONTEXT_LIMITS.statementMaxLength + 1)],
  ])("rejects %s objectives before Mission creation", async (_label, objective) => {
    const h = harness();
    const createMission = vi.spyOn(h.deps.missionService, "createMission");

    const result = await createMissionFromUserRequest(h.deps, { objective }, TRUSTED);

    expect(result).toEqual({
      ok: false,
      reason: "invalid_input",
      message: "La demande de mission est invalide.",
    });
    expect(createMission).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("accepts an objective exactly at the canonical 2,000-character bound", async () => {
    const h = harness();
    const objective = "x".repeat(CONTEXT_LIMITS.statementMaxLength);
    const result = await createMissionFromUserRequest(h.deps, { objective }, TRUSTED);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.objective).toBe(objective);
    expect(result.supervisorContext.input.confirmedObjective).toBe(objective);
  });

  it.each([
    ["tenantId", "attacker-tenant"],
    ["actorId", "attacker"],
    ["permission", "supervisor.worker.execute"],
    ["permissions", ["*"]],
    ["approval", true],
    ["approved", true],
    ["authorization", "allow"],
    ["authorizationLevel", 3],
    ["role", "owner"],
    ["roles", ["owner"]],
    ["SystemAgent", {}],
    ["ExecutionGrant", {}],
    ["productionAccess", true],
    ["mergeAllowed", true],
    ["policyOverride", true],
    ["grants", ["*"]],
    ["credentials", { token: "not-used" }],
    ["tokens", ["not-used"]],
    ["policyDecision", "allow"],
    ["approvedBy", "attacker"],
    ["surprise", true],
  ])("rejects unknown or authority-bearing field %s", async (field, value) => {
    const h = harness();
    const result = await createMissionFromUserRequest(
      h.deps,
      { objective: "Objectif légitime", [field]: value },
      TRUSTED,
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("rejects malformed trusted context without using request data as fallback", async () => {
    const h = harness();
    const result = await createMissionFromUserRequest(
      h.deps,
      { objective: "Objectif légitime" },
      { tenantId: "", actorId: "" },
    );

    expect(result).toMatchObject({ ok: false, reason: "invalid_trusted_context" });
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("createMissionFromUserRequest — fail closed and partial persistence", () => {
  it("stops before context persistence when canonical Mission creation fails", async () => {
    const h = harness();
    const missionService: CreateMissionFromUserRequestDeps["missionService"] = {
      createMission: async (): Promise<MissionResult<never>> => ({
        ok: false,
        reason: "persistence_error",
        message: "internal detail",
      }),
    };

    const result = await createMissionFromUserRequest(
      { ...h.deps, missionService },
      { objective: "Objectif valide" },
      TRUSTED,
    );

    expect(result).toEqual({
      ok: false,
      reason: "mission_creation_failed",
      message: "La mission n'a pas pu être créée.",
    });
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.resolveContext).not.toHaveBeenCalled();
  });

  it("does not expose exceptions thrown by canonical Mission creation", async () => {
    const h = harness();
    const missionService: CreateMissionFromUserRequestDeps["missionService"] = {
      createMission: async () => {
        throw new Error("sensitive persistence detail");
      },
    };

    const result = await createMissionFromUserRequest(
      { ...h.deps, missionService },
      { objective: "Objectif valide" },
      TRUSTED,
    );

    expect(result).toEqual({
      ok: false,
      reason: "mission_creation_failed",
      message: "La mission n'a pas pu être créée.",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive persistence detail");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("keeps the canonical Mission but stops before context persistence when build fails", async () => {
    const h = harness();
    const buildContext: NonNullable<CreateMissionFromUserRequestDeps["buildContext"]> = () => ({
      ok: false,
      reason: "mission_conflict",
    });

    const result = await createMissionFromUserRequest(
      { ...h.deps, buildContext },
      { objective: "Objectif valide" },
      TRUSTED,
    );

    expect(result).toMatchObject({ ok: false, reason: "context_build_failed" });
    expect(await h.missions.findActive()).toHaveLength(1);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.resolveContext).not.toHaveBeenCalled();
  });

  it("keeps the canonical Mission and stops before bridge when context persistence fails", async () => {
    const h = harness();
    const missionContexts: MissionContextRepository = {
      save: async () => ({
        ok: false,
        reason: "version_conflict",
      }),
      findLatest: async () => null,
      findVersion: async () => null,
    };

    const result = await createMissionFromUserRequest(
      { ...h.deps, missionContexts },
      { objective: "Objectif valide" },
      TRUSTED,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "context_persistence_failed",
    });
    expect(await h.missions.findActive()).toHaveLength(1);
    expect(h.resolveContext).not.toHaveBeenCalled();
  });

  it("keeps Mission and context persisted but returns failure when bridge refuses", async () => {
    const h = harness();
    const resolveContext: NonNullable<CreateMissionFromUserRequestDeps["resolveContext"]> = () => ({
      ok: false,
      reason: "schema_validation",
    });

    const result = await createMissionFromUserRequest(
      { ...h.deps, resolveContext },
      { objective: "Objectif valide" },
      TRUSTED,
    );

    expect(result).toMatchObject({ ok: false, reason: "bridge_failed" });
    expect(await h.missions.findActive()).toHaveLength(1);
    const mission = (await h.missions.findActive())[0];
    expect(await h.missionContexts.findLatest(TRUSTED.tenantId, mission.id)).not.toBeNull();
  });

  it("has no Supervisor execution, DAG, worker, D4, or authority dependency", () => {
    const source = readFileSync(
      new URL("./create-mission-from-user-request.ts", import.meta.url),
      "utf8",
    );

    for (const forbidden of [
      "SupervisorService",
      "TaskDag",
      "WorkerManager",
      "D4",
      "SystemAgent",
      "ExecutionGrant",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
