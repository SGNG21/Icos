import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { buildMissionContext, resolveSupervisorContext } from "@/core/context";
import type { Capability } from "@/core/contracts";
import { SYSTEM_ACTIONS, type PolicyDecision } from "@/core/policy";
import { getSelfStateSnapshot } from "@/server/self-state/get-self-state-snapshot";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryMissionContextRepository } from "@/server/context/in-memory/mission-context-repository";
import { InMemoryMissionRepository } from "@/server/mission/in-memory/mission-repository";
import { MissionService } from "@/server/mission/mission-service";
import type { D1PolicyPort } from "@/server/policy/ports";
import type { CapabilityRepository } from "@/server/repositories/capability-ports";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemorySupervisorRepository } from "@/server/supervisor/in-memory/supervisor-repository";
import type { SupervisorExecutionResult } from "@/server/supervisor/supervisor-service";
import {
  getCapabilitySnapshot,
  type CapabilityAvailabilityProbe,
  type TechnicalAvailabilityAssessment,
} from "@/server/usecases/get-capability-snapshot";

import {
  planAndExecuteMission,
  REQUIRED_MISSION_CAPABILITY_KEYS,
  type PlanAndExecuteMissionDeps,
} from "./plan-and-execute-mission";

const NOW = "2026-07-28T08:00:00.000Z";
const TRUSTED = { tenantId: "tenant-1", actorId: "human-1" };
const OBJECTIVE = "Implement repository change $(do-not-run) && preserve exactly";
const REQUIRED_CAPABILITY_KEY = SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE;

function capability(): Capability {
  return {
    id: "cap-supervisor-worker-execute",
    key: REQUIRED_CAPABILITY_KEY,
    name: "Supervisor worker execution",
    category: "code",
    status: "active",
    sensitivityLevel: "C1",
    dataCategory: "INTERNAL",
    retentionPolicyRef: {
      maxRetentionDays: 30,
      legalBasis: "contract",
      purpose: "bounded mission supervision",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function policy(outcome: "allow" | "deny" | "require_approval" = "allow"): D1PolicyPort {
  return {
    decide: vi.fn(async () => {
      if (outcome === "allow") {
        return {
          outcome,
          reason: "allowed by test policy",
          attestedAt: NOW,
        } satisfies PolicyDecision;
      }
      if (outcome === "deny") {
        return {
          outcome,
          reason: "denied by policy",
          code: "forbidden",
        } satisfies PolicyDecision;
      }
      return {
        outcome,
        reason: "human approval required",
        expiresAt: "2026-07-28T09:00:00.000Z",
      } satisfies PolicyDecision;
    }),
  };
}

function availability(
  state: "AVAILABLE" | "UNAVAILABLE" = "AVAILABLE",
): CapabilityAvailabilityProbe {
  return {
    check: vi.fn(async () => {
      const result: TechnicalAvailabilityAssessment = {
        state,
        evidence: [
          {
            component: "CAPABILITY",
            key: REQUIRED_CAPABILITY_KEY,
            state,
            source: "INJECTED_RUNTIME_PROBE",
            reason: `runtime is ${state.toLowerCase()}`,
          },
        ],
      };
      return result;
    }),
  };
}

async function harness(options?: {
  tenantId?: string;
  objective?: string;
  policyOutcome?: "allow" | "deny" | "require_approval";
  availabilityState?: "AVAILABLE" | "UNAVAILABLE";
  capabilities?: Capability[];
}) {
  const missions = new InMemoryMissionRepository();
  const audit = new InMemoryAuditRepository(new InMemoryAuditLog());
  const missionService = new MissionService(missions, audit);
  const missionContexts = new InMemoryMissionContextRepository();
  const tenantId = options?.tenantId ?? TRUSTED.tenantId;
  const objective = options?.objective ?? OBJECTIVE;
  const created = await missionService.createMission({ tenantId, userRequest: objective });
  if (!created.ok) throw new Error("test mission creation failed");
  const mission = created.data;
  const built = buildMissionContext({
    conversation: {
      tenantId,
      turns: [
        {
          id: "turn-objective",
          role: "user",
          text: objective,
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: NOW,
        },
      ],
      memoryReferences: [],
    },
    mission,
    builtByLabel: TRUSTED.actorId,
    now: NOW,
    version: 0,
  });
  if (!built.ok) throw new Error("test context build failed");
  const saved = await missionContexts.save({
    context: built.context,
    expectedVersion: null,
  });
  if (!saved.ok) throw new Error("test context save failed");

  const capabilityRepository: Pick<CapabilityRepository, "list"> = {
    list: vi.fn(async () => structuredClone(options?.capabilities ?? [capability()])),
  };
  const supervisorRepository = new InMemorySupervisorRepository();
  const supervisor = {
    execute: vi.fn(
      async (
        dag: Parameters<PlanAndExecuteMissionDeps["supervisor"]["execute"]>[0],
      ): Promise<SupervisorExecutionResult> => {
        await supervisorRepository.createDag({
          id: dag.id,
          missionId: dag.missionId,
          tenantId: dag.tenantId,
          nodes: Object.values(dag.nodes),
        });
        await supervisorRepository.updateDagStatus(dag.id, "SCHEDULING");
        await supervisorRepository.updateDagStatus(dag.id, "EXECUTING");
        for (const node of Object.values(dag.nodes)) {
          await supervisorRepository.updateNodeStatus(dag.id, node.id, "READY");
          await supervisorRepository.updateNodeStatus(dag.id, node.id, "ASSIGNED");
          await supervisorRepository.updateNodeStatus(dag.id, node.id, "RUNNING");
          await supervisorRepository.updateNodeStatus(dag.id, node.id, "REVIEWING");
          await supervisorRepository.updateNodeStatus(dag.id, node.id, "SUCCEEDED");
        }
        const completedDag = await supervisorRepository.updateDagStatus(dag.id, "COMPLETED");
        if (!completedDag) throw new Error("test DAG completion failed");
        return {
          dag: completedDag,
          status: "SUCCEEDED" as const,
          summary: "canonical supervisor success",
        };
      },
    ),
  };
  const getSelfState = vi.fn(() => getSelfStateSnapshot());
  const getCapabilities = vi.fn(getCapabilitySnapshot);
  const resolveContext = vi.fn(resolveSupervisorContext);
  const validateTaskDag = vi.fn(
    (nodes: Parameters<NonNullable<PlanAndExecuteMissionDeps["validateTaskDag"]>>[0]) => {
      void nodes;
      return [];
    },
  );
  const setPlan = vi.spyOn(missionService, "setPlan");
  const transitionStatusCanonical = missionService.transitionStatus.bind(missionService);
  const transitionStatus = vi.spyOn(missionService, "transitionStatus");

  const deps: PlanAndExecuteMissionDeps = {
    missionService,
    missionContexts,
    capabilitySnapshotDeps: {
      capabilities: capabilityRepository,
      policy: policy(options?.policyOutcome),
      availability: availability(options?.availabilityState),
    },
    supervisor,
    supervisorRepository,
    clock: () => new Date(NOW),
    getSelfState,
    getCapabilities,
    resolveContext,
    validateTaskDag,
  };

  return {
    deps,
    mission,
    missions,
    missionContexts,
    capabilityRepository,
    supervisorRepository,
    supervisor,
    getSelfState,
    getCapabilities,
    resolveContext,
    validateTaskDag,
    setPlan,
    transitionStatusCanonical,
    transitionStatus,
  };
}

async function execute(
  h: Awaited<ReturnType<typeof harness>>,
  input: unknown = {
    missionId: h.mission.id,
  },
  trusted: unknown = TRUSTED,
) {
  return planAndExecuteMission(h.deps, input, trusted);
}

describe("planAndExecuteMission — strict boundaries", () => {
  it("accepts the strict missionId-only input", async () => {
    const h = await harness();
    const result = await execute(h);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["tenantId", "attacker"],
    ["actorId", "attacker"],
    ["permission", "allow"],
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
    ["credentials", ["secret"]],
    ["tokens", ["secret"]],
    ["capabilityOverrides", ["*"]],
    ["taskCount", 10],
    ["command", "rm -rf repository"],
  ])("rejects unknown input field %s", async (field, value) => {
    const h = await harness();
    const result = await execute(h, { missionId: h.mission.id, [field]: value });
    expect(result).toEqual({
      ok: false,
      reason: "invalid_input",
      message: "La demande de supervision est invalide.",
    });
    expect(h.getSelfState).not.toHaveBeenCalled();
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("keeps trusted tenantId and actorId separate from request input", async () => {
    const h = await harness();
    const result = await execute(h);
    expect(result.ok).toBe(true);
    expect(h.transitionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ actorLabel: TRUSTED.actorId }),
    );
    expect(h.getCapabilities.mock.calls[0]?.[1].policyRequest.actor).toMatchObject({
      kind: "human",
      id: TRUSTED.actorId,
      tenantId: TRUSTED.tenantId,
    });
    expect(h.getCapabilities.mock.calls[0]?.[1].policyRequest.actor.roles).toBeUndefined();
    expect(
      h.getCapabilities.mock.calls[0]?.[1].policyRequest.actor.authorizationLevel,
    ).toBeUndefined();
  });
});

describe("planAndExecuteMission — canonical reads and isolation", () => {
  it("loads the canonical Mission through MissionService", async () => {
    const h = await harness();
    const getMission = vi.spyOn(h.deps.missionService, "getMission");
    await execute(h);
    expect(getMission).toHaveBeenCalledWith(h.mission.id);
  });

  it("fails closed when the Mission is missing", async () => {
    const h = await harness();
    const result = await execute(h, { missionId: "mission-missing" });
    expect(result).toEqual({
      ok: false,
      reason: "mission_unavailable",
      message: "La mission n'est pas disponible.",
    });
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the Mission state is incompatible", async () => {
    const h = await harness();
    await h.missions.update({ ...h.mission, status: "PLANNING" });
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mission_state_incompatible");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("blocks cross-tenant access without distinguishing it from a missing Mission", async () => {
    const h = await harness({ tenantId: "tenant-other" });
    const result = await execute(h);
    expect(result).toEqual({
      ok: false,
      reason: "mission_unavailable",
      message: "La mission n'est pas disponible.",
    });
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("loads the latest canonical MissionContext with trusted tenant scope", async () => {
    const h = await harness();
    const findLatest = vi.spyOn(h.missionContexts, "findLatest");
    await execute(h);
    expect(findLatest).toHaveBeenCalledWith(TRUSTED.tenantId, h.mission.id);
  });

  it("fails closed when MissionContext is missing", async () => {
    const h = await harness();
    h.deps.missionContexts = { findLatest: vi.fn(async () => null) };
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mission_context_unavailable");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", { tenantId: "tenant-other" }],
    ["mission", { missionId: "mission-other" }],
  ])("fails closed on mismatched context %s", async (_label, mismatch) => {
    const h = await harness();
    const canonical = await h.missionContexts.findLatest(TRUSTED.tenantId, h.mission.id);
    h.deps.missionContexts = {
      findLatest: vi.fn(async () =>
        canonical ? ({ ...canonical, ...mismatch } as typeof canonical) : null,
      ),
    };
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mission_context_mismatch");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical context bridge refuses delivery", async () => {
    const h = await harness();
    h.deps.resolveContext = vi.fn(() => ({
      ok: false as const,
      reason: "precedence_conflict" as const,
    }));
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("context_bridge_failed");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });
});

describe("planAndExecuteMission — SelfState preflight", () => {
  it("loads canonical SelfState and uses it descriptively only", async () => {
    const h = await harness();
    const result = await execute(h);
    expect(result.ok).toBe(true);
    expect(h.getSelfState).toHaveBeenCalledOnce();
    if (!result.ok) return;
    expect(result).not.toHaveProperty("selfStateAuthority");
    expect(result).not.toHaveProperty("authorization");
    expect(result).not.toHaveProperty("ExecutionGrant");
  });

  it("fails closed when SelfState is unavailable or malformed", async () => {
    const h = await harness();
    h.deps.getSelfState = vi.fn(() => {
      throw new Error("unavailable");
    });
    const unavailable = await execute(h);
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.reason).toBe("self_state_unavailable");

    h.deps.getSelfState = vi.fn(() => ({ schemaVersion: 999 }) as never);
    const malformed = await execute(h);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.reason).toBe("self_state_invalid");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["LOCAL_DEV_ONLY", false],
    ["CLIENT_SYSTEM_ACCESS", true],
    ["PRODUCTION_ACCESS", true],
    ["CLIENT_CREDENTIALS", "allowed"],
    ["EXTERNAL_IRREVERSIBLE_ACTIONS", "allowed"],
  ])("fails closed when local-only invariant %s is violated", async (field, value) => {
    const h = await harness();
    const snapshot = structuredClone(getSelfStateSnapshot()) as Record<string, unknown>;
    snapshot.operatingMode = {
      ...(snapshot.operatingMode as Record<string, unknown>),
      [field]: value,
    };
    h.deps.getSelfState = vi.fn(() => snapshot as never);
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("self_state_invalid");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });
});

describe("planAndExecuteMission — canonical capability preflight", () => {
  it("loads CapabilitySnapshot through canonical getCapabilitySnapshot and repository list", async () => {
    const h = await harness();
    await execute(h);
    expect(REQUIRED_MISSION_CAPABILITY_KEYS).toEqual([SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE]);
    expect(h.getCapabilities).toHaveBeenCalledOnce();
    expect(h.capabilityRepository.list).toHaveBeenCalledOnce();
  });

  it("missing capability evidence never executes and returns PROVIDER_UNAVAILABLE", async () => {
    const h = await harness({ capabilities: [] });
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("PROVIDER_UNAVAILABLE");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("a failed availability probe never becomes ALLOWED", async () => {
    const h = await harness();
    h.deps.capabilitySnapshotDeps.availability = {
      check: vi.fn(async () => {
        throw new Error("probe failed");
      }),
    };
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("PROVIDER_UNAVAILABLE");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("APPROVAL_REQUIRED persists the Plan, waits, never creates approval, and never calls Supervisor", async () => {
    const h = await harness({ policyOutcome: "require_approval" });
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("WAITING_FOR_APPROVAL");
    if (result.outcome !== "WAITING_FOR_APPROVAL") return;
    expect(result.mission.status).toBe("WAITING_FOR_APPROVAL");
    expect(result.blockers[0]?.permissionState).toBe("APPROVAL_REQUIRED");
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);
    expect(h.setPlan).toHaveBeenCalledOnce();
    expect(h.supervisor.execute).not.toHaveBeenCalled();
    expect(h.deps).not.toHaveProperty("approvals");
  });

  it("DENIED transitions to BLOCKED_BY_POLICY and never calls Supervisor", async () => {
    const h = await harness({ policyOutcome: "deny" });
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("BLOCKED_BY_POLICY");
    if (result.outcome !== "BLOCKED_BY_POLICY") return;
    expect(result.mission.status).toBe("BLOCKED_BY_POLICY");
    expect(result.blockers[0]?.permissionState).toBe("DENIED");
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("UNAVAILABLE transitions to PROVIDER_UNAVAILABLE and never calls Supervisor", async () => {
    const h = await harness({ availabilityState: "UNAVAILABLE" });
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("PROVIDER_UNAVAILABLE");
    if (result.outcome !== "PROVIDER_UNAVAILABLE") return;
    expect(result.mission.status).toBe("PROVIDER_UNAVAILABLE");
    expect(result.blockers[0]?.permissionState).toBe("UNAVAILABLE");
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });
});

describe("planAndExecuteMission — bounded planning and canonical Supervisor boundary", () => {
  it("persists one exact-objective Plan with every required safeguard", async () => {
    const h = await harness();
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("EXECUTED");
    if (result.outcome !== "EXECUTED") return;
    expect(result.plan.totalSteps).toBe(1);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0].description).toBe(OBJECTIVE);
    const node = Object.values(result.dag.nodes)[0];
    expect(node.description).toBe(OBJECTIVE);
    expect(node.acceptanceCriteria.join(" ")).toMatch(/focused tests/i);
    expect(node.acceptanceCriteria.join(" ")).toMatch(/independent review/i);
    expect(node.acceptanceCriteria.join(" ")).toMatch(/GlobalGates/);
    expect(node.acceptanceCriteria.join(" ")).toMatch(/Stop before merge/i);
    expect(node).not.toHaveProperty("command");
    expect(h.setPlan).toHaveBeenCalledWith({
      missionId: h.mission.id,
      plan: result.plan,
      actorLabel: TRUSTED.actorId,
    });
  });

  it("uses only legal checked Mission transitions", async () => {
    const h = await harness();
    const result = await execute(h);
    expect(result.ok).toBe(true);
    expect(h.transitionStatus.mock.calls.map(([input]) => input.targetStatus)).toEqual([
      "PLANNING",
      "IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(result.ok && result.outcome === "EXECUTED" ? result.mission.status : null).toBe(
      "COMPLETED",
    );
    expect((await h.missions.findById(h.mission.id))?.status).toBe("COMPLETED");
  });

  it("fails closed when a canonical transition fails", async () => {
    const h = await harness();
    h.transitionStatus.mockResolvedValueOnce({
      ok: false,
      reason: "invalid_transition",
      message: "rejected",
    });
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mission_transition_failed");
    expect(h.setPlan).not.toHaveBeenCalled();
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("fails closed without an internal error leak when a transition throws", async () => {
    const h = await harness();
    h.transitionStatus.mockRejectedValueOnce(new Error("internal repository details"));
    const result = await execute(h);
    expect(result).toEqual({
      ok: false,
      reason: "mission_transition_failed",
      message: "La transition canonique vers PLANNING a échoué.",
    });
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("fails closed when canonical Plan persistence is rejected", async () => {
    const h = await harness();
    h.setPlan.mockResolvedValueOnce({
      ok: false,
      reason: "invalid_state",
      message: "rejected",
    });
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("plan_persistence_failed");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("creates and validates one canonical deterministic mission-scoped DAG", async () => {
    const h = await harness();
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok || result.outcome !== "EXECUTED") return;
    expect(result.dag.id).toBe(`dag-${h.mission.id}`);
    expect(result.dag.missionId).toBe(h.mission.id);
    expect(result.dag.tenantId).toBe(TRUSTED.tenantId);
    expect(Object.values(result.dag.nodes)).toHaveLength(1);
    expect(Object.values(result.dag.nodes)[0].dependsOn).toEqual([]);
    expect(h.validateTaskDag).toHaveBeenCalledOnce();
  });

  it("fails closed when canonical DAG validation fails", async () => {
    const h = await harness();
    h.deps.validateTaskDag = vi.fn(() => ["cycle"]);
    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("dag_validation_failed");
    expect(h.supervisor.execute).not.toHaveBeenCalled();
  });

  it("does not return EXECUTED when the canonical COMPLETED transition is rejected", async () => {
    const h = await harness();
    h.transitionStatus.mockImplementation(async (input) => {
      if (input.targetStatus === "COMPLETED") {
        return {
          ok: false,
          reason: "invalid_transition",
          message: "rejected",
        };
      }
      return h.transitionStatusCanonical(input);
    });

    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mission_transition_failed");
    expect(result.mission?.status).toBe("IN_PROGRESS");
    expect(result.dag?.status).toBe("COMPLETED");
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);
    expect((await h.missions.findById(h.mission.id))?.status).toBe("IN_PROGRESS");
  });

  it("transitions the Mission to FAILED after Supervisor failure", async () => {
    const h = await harness();
    h.supervisor.execute.mockResolvedValueOnce({
      dag: {
        id: `dag-${h.mission.id}`,
        missionId: h.mission.id,
        tenantId: h.mission.tenantId,
        status: "FAILED",
        nodes: {},
        nodeOrder: [],
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
      },
      status: "FAILED",
      summary: "deterministic failure",
    });

    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("supervisor_execution_failed");
    expect(result.mission?.status).toBe("FAILED");
    expect((await h.missions.findById(h.mission.id))?.status).toBe("FAILED");
  });

  it("retains Supervisor failure when the canonical FAILED transition is rejected", async () => {
    const h = await harness();
    h.supervisor.execute.mockResolvedValueOnce({
      dag: {
        id: `dag-${h.mission.id}`,
        missionId: h.mission.id,
        tenantId: h.mission.tenantId,
        status: "FAILED",
        nodes: {},
        nodeOrder: [],
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW,
      },
      status: "FAILED",
      summary: "deterministic failure",
    });
    h.transitionStatus.mockImplementation(async (input) => {
      if (input.targetStatus === "FAILED") {
        return {
          ok: false,
          reason: "invalid_transition",
          message: "rejected",
        };
      }
      return h.transitionStatusCanonical(input);
    });

    const result = await execute(h);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("supervisor_execution_failed");
    expect(result.message).toMatch(/Supervisor.*FAILED.*également échoué/);
    expect(result.mission?.status).toBe("IN_PROGRESS");
    expect((await h.missions.findById(h.mission.id))?.status).toBe("IN_PROGRESS");
  });

  it("resolves context and passes only canonical DAG and enriched context to Supervisor.execute", async () => {
    const h = await harness();
    const result = await execute(h);
    expect(result.ok).toBe(true);
    if (!result.ok || result.outcome !== "EXECUTED") return;
    expect(h.resolveContext).toHaveBeenCalledOnce();
    const bridge = h.resolveContext.mock.results[0]?.value;
    expect(bridge?.ok).toBe(true);
    if (!bridge?.ok) return;
    expect(h.supervisor.execute).toHaveBeenCalledOnce();
    expect(h.supervisor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: h.mission.id,
        tenantId: TRUSTED.tenantId,
      }),
      bridge.envelope,
    );
    expect(result.executionResult.status).toBe("SUCCEEDED");
    expect(result.dag).toEqual(result.executionResult.dag);
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);
  });

  it("introduces no D1, D4, WorkerManager, WorktreeManager, GlobalGates, merge, production, or rollback bypass", () => {
    const source = readFileSync("src/server/usecases/plan-and-execute-mission.ts", "utf8");
    expect(source).toContain("SupervisorService");
    expect(source).toContain("getCapabilitySnapshot");
    expect(source).not.toMatch(/server\/runtime/);
    expect(source).not.toMatch(/server\/worker/);
    expect(source).not.toMatch(/server\/worktree/);
    expect(source).not.toMatch(/server\/integration\/global-gates/);
    expect(source).not.toMatch(/\.merge\(/);
    expect(source).not.toMatch(/deploy\(/);
    expect(source).not.toMatch(/rollback\(/);
    expect(source).toMatch(/Partial persistence is intentional and honest/);
    expect(source).toMatch(/never deletes or/);
  });
});
