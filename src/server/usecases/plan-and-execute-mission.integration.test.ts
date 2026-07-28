import { describe, expect, it, vi } from "vitest";

import { buildMissionContext, resolveSupervisorContext } from "@/core/context";
import type { Capability } from "@/core/contracts";
import type { ExecutionResult } from "@/core/runtime";
import {
  PERMISSION_SUPERVISOR_WORKER_EXECUTE,
  SYSTEM_ACTIONS,
  type PolicyDecision,
} from "@/core/policy";
import { validateDag, type TaskDag } from "@/core/supervisor";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryMissionContextRepository } from "@/server/context/in-memory/mission-context-repository";
import { InMemoryMissionRepository } from "@/server/mission/in-memory/mission-repository";
import { MissionService } from "@/server/mission/mission-service";
import { D1PolicyService } from "@/server/policy/d1-policy-service";
import type { D1PolicyPort } from "@/server/policy/ports";
import type { CapabilityAvailabilityProbe } from "@/server/usecases/get-capability-snapshot";
import type { TechnicalAvailabilityAssessment } from "@/server/usecases/get-capability-snapshot";
import { getCapabilitySnapshot } from "@/server/usecases/get-capability-snapshot";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";
import { getSelfStateSnapshot } from "@/server/self-state/get-self-state-snapshot";
import { InMemorySupervisorRepository } from "@/server/supervisor/in-memory/supervisor-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { WorkerManager } from "@/server/worker/worker-manager";

import { planAndExecuteMission } from "./plan-and-execute-mission";

const NOW = "2026-07-28T08:00:00.000Z";
const TENANT_ID = "tenant-bridge";
const ACTOR_ID = "human-bridge";
const OBJECTIVE = "Preserve this exact mission objective; do not infer authority.";
const REQUIRED_CAPABILITY = SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE;
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);

type CapabilityMode = "ALLOWED" | "MISSING" | "APPROVAL_REQUIRED" | "DENIED" | "UNAVAILABLE";
type PersistedReadMode = "NORMAL" | "MISSING" | "NOT_COMPLETED" | "NODE_NOT_SUCCEEDED";
type ReturnedMode = "NORMAL" | "STATUS_FAILED" | "DAG_FAILED";

interface HarnessOptions {
  mission?: "PRESENT" | "MISSING" | "CROSS_TENANT";
  context?: "PRESENT" | "MISSING";
  selfState?: "VALID" | "INVALID";
  capability?: CapabilityMode;
  runtime?: "SUCCEEDED" | "FAILED";
  persistedRead?: PersistedReadMode;
  returned?: ReturnedMode;
}

function canonicalCapability(): Capability {
  return {
    id: "cap-supervisor-worker-execute",
    key: REQUIRED_CAPABILITY,
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

function preflightPolicy(mode: CapabilityMode): D1PolicyPort {
  return {
    decide: vi.fn(async (): Promise<PolicyDecision> => {
      if (mode === "APPROVAL_REQUIRED") {
        return {
          outcome: "require_approval",
          reason: "explicit approval required",
          expiresAt: "2026-07-28T09:00:00.000Z",
        };
      }
      if (mode === "DENIED") {
        return {
          outcome: "deny",
          reason: "explicit policy denial",
          code: "forbidden",
        };
      }
      return {
        outcome: "allow",
        reason: "deterministic bridge preflight",
        attestedAt: NOW,
      };
    }),
  };
}

async function createHarness(options: HarnessOptions = {}) {
  const missionMode = options.mission ?? "PRESENT";
  const contextMode = options.context ?? "PRESENT";
  const selfStateMode = options.selfState ?? "VALID";
  const capabilityMode = options.capability ?? "ALLOWED";
  const runtimeMode = options.runtime ?? "SUCCEEDED";
  const persistedReadMode = options.persistedRead ?? "NORMAL";
  const returnedMode = options.returned ?? "NORMAL";

  const missionRepository = new InMemoryMissionRepository();
  const missionService = new MissionService(
    missionRepository,
    new InMemoryAuditRepository(new InMemoryAuditLog()),
  );
  const missionContexts = new InMemoryMissionContextRepository();
  const missionTenant = missionMode === "CROSS_TENANT" ? "tenant-other" : TENANT_ID;

  let missionId = "mission-missing";
  if (missionMode !== "MISSING") {
    const created = await missionService.createMission({
      tenantId: missionTenant,
      userRequest: OBJECTIVE,
    });
    if (!created.ok) throw new Error("canonical Mission fixture creation failed");
    missionId = created.data.id;

    if (contextMode === "PRESENT") {
      const built = buildMissionContext({
        conversation: {
          tenantId: missionTenant,
          turns: [
            {
              id: "turn-objective",
              role: "user",
              text: OBJECTIVE,
              confirmed: true,
              isObjective: true,
              isOpenQuestion: false,
              conflictsWithMission: false,
              observedAt: NOW,
            },
          ],
          memoryReferences: [],
        },
        mission: created.data,
        builtByLabel: ACTOR_ID,
        now: NOW,
        version: 0,
      });
      if (!built.ok) throw new Error("canonical MissionContext fixture creation failed");
      const saved = await missionContexts.save({
        context: built.context,
        expectedVersion: null,
      });
      if (!saved.ok) throw new Error("canonical MissionContext fixture persistence failed");
    }
  }

  const capabilityRepository = new InMemoryCapabilityRepository(
    capabilityMode === "MISSING" ? [] : [canonicalCapability()],
  );
  const availability: CapabilityAvailabilityProbe = {
    check: vi.fn(async (): Promise<TechnicalAvailabilityAssessment> => {
      const state = capabilityMode === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE";
      return {
        state,
        evidence: [
          {
            component: "CAPABILITY",
            key: REQUIRED_CAPABILITY,
            state,
            source: "INJECTED_RUNTIME_PROBE",
            reason: "deterministic local-only bridge probe",
          },
        ],
      };
    }),
  };

  const runtimeResult: ExecutionResult =
    runtimeMode === "SUCCEEDED"
      ? {
          ok: true,
          state: "SUCCEEDED",
          output: { bounded: true },
          artifacts: [],
          latencyMs: 1,
        }
      : {
          ok: false,
          state: "FAILED",
          error: {
            code: "PROCESS_ERROR",
            message: "deterministic worker failure",
            retryable: false,
          },
          artifacts: [],
          latencyMs: 1,
        };
  const runtime = {
    execute: vi.fn(async () => runtimeResult),
  };
  const workerPolicy = new D1PolicyService();
  const d1Decide = vi.spyOn(workerPolicy, "decide");
  const workerManager = new WorkerManager(runtime, workerPolicy, 1);

  const worktrees = {
    createWorktree: vi.fn(async (taskId: string) => ({
      path: `/virtual/worktrees/${taskId}`,
      branch: `bridge/${taskId}`,
      baseSha: BASE_SHA,
      taskId,
    })),
    assignToTask: vi.fn(async () => undefined),
    captureResult: vi.fn(async () => ({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      changedFiles: ["virtual-proof.txt"],
      isDirty: false,
      uncommittedFiles: [],
      commitMessages: ["test: deterministic bridge proof"],
      commitShas: [HEAD_SHA],
    })),
    detectChanges: vi.fn(async () => ["virtual-proof.txt"]),
    cleanupWorktree: vi.fn(async () => undefined),
    listActive: vi.fn(async () => []),
  };

  let reviewCount = 0;
  const reviewer = {
    conductReview: vi.fn(async () => {
      reviewCount++;
      if (reviewCount === 1) {
        return {
          verdict: "CHANGES_REQUIRED" as const,
          checks: [
            {
              category: "tests" as const,
              description: "exercise correction boundary",
              passed: false,
            },
          ],
          summary: "deterministic correction required",
          comments: "apply the bounded deterministic correction",
          confidence: 5,
          durationMs: 1,
          reviewerWorkerId: "reviewer-bridge",
          completedAt: NOW,
        };
      }
      return {
        verdict: "PASS" as const,
        checks: [
          {
            category: "tests" as const,
            description: "bounded proof passes",
            passed: true,
          },
        ],
        summary: "deterministic independent review passed",
        confidence: 5,
        durationMs: 1,
        reviewerWorkerId: "reviewer-bridge",
        completedAt: NOW,
      };
    }),
    ensureIndependentReview: vi.fn(
      async (implementerWorkerId: string, reviewerWorkerId: string) =>
        implementerWorkerId !== reviewerWorkerId,
    ),
  };
  const corrector = {
    executeCorrection: vi.fn(async () => ({
      outcome: "CORRECTED" as const,
      summary: "deterministic bounded correction",
      commitSha: HEAD_SHA,
      durationMs: 1,
    })),
    isMaxAttemptsReached: vi.fn(() => false),
    escalate: vi.fn(async () => undefined),
  };
  const gates = {
    executeAll: vi.fn(async (workspacePath: string) => {
      void workspacePath;
      return [
        {
          gate: "bridge-deterministic",
          passed: true,
          output: "pass",
          durationMs: 1,
          errors: [],
        },
      ];
    }),
    executeGate: vi.fn(async (gate: string, workspacePath: string) => {
      void gate;
      void workspacePath;
      return {
        gate: "bridge-deterministic",
        passed: true,
        output: "pass",
        durationMs: 1,
        errors: [],
      };
    }),
    gitDiffCheck: vi.fn(async (workspacePath: string) => {
      void workspacePath;
      return {
        gate: "git diff --check",
        passed: true,
        output: "",
        durationMs: 1,
        errors: [],
      };
    }),
  };
  const irreversible = {
    approvals: 0,
    merge: 0,
    push: 0,
    deployment: 0,
    production: 0,
    external: 0,
  };
  const integrator = {
    integrate: vi.fn(async () => {
      const gateResults = await gates.executeAll("/virtual/integration");
      return {
        status: "SUCCEEDED" as const,
        gateResults,
        commitsIntegrated: 1,
        summary: "deterministic integration without merge or push",
        durationMs: 1,
      };
    }),
  };
  const preview = {
    deliver: vi.fn(async () => {
      irreversible.deployment++;
      irreversible.production++;
      return {
        status: "FAILED" as const,
        url: "",
        summary: "preview must not be called",
        durationMs: 0,
        completedAt: NOW,
      };
    }),
  };

  const supervisorRepository = new InMemorySupervisorRepository();
  const supervisor = new SupervisorService(
    supervisorRepository,
    workerManager,
    worktrees,
    reviewer,
    corrector,
    gates,
    integrator,
    preview,
    {
      maxConcurrentWorkers: 1,
      maxCorrectionRetries: 1,
      defaultWorkerTimeoutMs: 1_000,
      agentIdentity: {
        id: "supervisor-bridge",
        tenantId: TENANT_ID,
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 2,
        justification: "Exercise the canonical D1 worker boundary in STEP 6.",
      },
    },
  );
  const realSupervisorExecute = supervisor.execute.bind(supervisor);
  let dagBeforeSupervisor: TaskDag | null = null;
  const supervisorExecute = vi
    .spyOn(supervisor, "execute")
    .mockImplementation(async (dag, context) => {
      dagBeforeSupervisor = await supervisorRepository.findDagById(dag.id);
      const result = await realSupervisorExecute(dag, context);
      if (returnedMode === "STATUS_FAILED") {
        return { ...result, status: "FAILED", summary: "inconsistent returned status" };
      }
      if (returnedMode === "DAG_FAILED") {
        return {
          ...result,
          dag: { ...result.dag, status: "FAILED" },
          summary: "inconsistent returned DAG",
        };
      }
      return result;
    });

  const persistedReader = {
    findDagById: vi.fn(async (dagId: string) => {
      const persisted = await supervisorRepository.findDagById(dagId);
      if (!persisted || persistedReadMode === "MISSING") return null;
      if (persistedReadMode === "NOT_COMPLETED") {
        return { ...persisted, status: "EXECUTING" as const };
      }
      if (persistedReadMode === "NODE_NOT_SUCCEEDED") {
        const firstNode = Object.values(persisted.nodes)[0];
        if (!firstNode) return persisted;
        return {
          ...persisted,
          nodes: {
            ...persisted.nodes,
            [firstNode.id]: { ...firstNode, status: "FAILED" as const },
          },
        };
      }
      return persisted;
    }),
  };

  const getSelfState = vi.fn((): ReturnType<typeof getSelfStateSnapshot> => {
    const canonical = getSelfStateSnapshot();
    if (selfStateMode === "VALID") return canonical;
    return {
      ...canonical,
      operatingMode: {
        ...canonical.operatingMode,
        LOCAL_DEV_ONLY: false,
        PRODUCTION_ACCESS: true,
      },
    } as unknown as ReturnType<typeof getSelfStateSnapshot>;
  });
  const getCapabilities = vi.fn(getCapabilitySnapshot);
  const resolveContext = vi.fn(resolveSupervisorContext);
  const validateTaskDag = vi.fn(validateDag);
  const transitionStatusCanonical = missionService.transitionStatus.bind(missionService);
  const transitionStatus = vi.spyOn(missionService, "transitionStatus");
  const setPlan = vi.spyOn(missionService, "setPlan");

  const result = async () =>
    planAndExecuteMission(
      {
        missionService,
        missionContexts,
        capabilitySnapshotDeps: {
          capabilities: capabilityRepository,
          policy: preflightPolicy(capabilityMode),
          availability,
        },
        supervisor,
        supervisorRepository: persistedReader,
        clock: () => new Date(NOW),
        getSelfState,
        getCapabilities,
        resolveContext,
        validateTaskDag,
      },
      { missionId },
      { tenantId: TENANT_ID, actorId: ACTOR_ID },
    );

  return {
    result,
    missionId,
    missionRepository,
    missionService,
    missionContexts,
    supervisorRepository,
    supervisorExecute,
    getSelfState,
    getCapabilities,
    resolveContext,
    validateTaskDag,
    transitionStatusCanonical,
    transitionStatus,
    setPlan,
    runtime,
    d1Decide,
    worktrees,
    reviewer,
    corrector,
    gates,
    integrator,
    preview,
    irreversible,
    get dagBeforeSupervisor() {
      return dagBeforeSupervisor;
    },
  };
}

function expectNoIrreversibleAction(
  irreversible: Awaited<ReturnType<typeof createHarness>>["irreversible"],
) {
  expect(irreversible).toEqual({
    approvals: 0,
    merge: 0,
    push: 0,
    deployment: 0,
    production: 0,
    external: 0,
  });
}

describe("planAndExecuteMission — real bridge integration", () => {
  it("executes the canonical one-step bridge through the real SupervisorService", async () => {
    const h = await createHarness();
    const result = await h.result();

    expect(result.ok).toBe(true);
    if (!result.ok || result.outcome !== "EXECUTED") return;

    expect(result.plan.totalSteps).toBe(1);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]?.description).toBe(OBJECTIVE);
    expect(result.mission.userRequest).toBe(OBJECTIVE);
    expect(result.mission.status).toBe("COMPLETED");
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);

    expect(h.getSelfState).toHaveBeenCalledOnce();
    expect(h.getCapabilities).toHaveBeenCalledOnce();
    expect(h.getCapabilities.mock.calls[0]?.[1].policyRequest.action).toBe(REQUIRED_CAPABILITY);
    expect(h.resolveContext).toHaveBeenCalledOnce();
    expect(h.validateTaskDag).toHaveBeenCalledOnce();
    expect(h.transitionStatus.mock.calls.map(([input]) => input.targetStatus)).toEqual([
      "PLANNING",
      "IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(h.setPlan).toHaveBeenCalledOnce();

    expect(Object.values(result.dag.nodes)).toHaveLength(1);
    expect(Object.values(result.dag.nodes)[0]?.dependsOn).toEqual([]);
    expect(validateDag(Object.values(result.dag.nodes))).toEqual([]);
    expect(h.dagBeforeSupervisor).toBeNull();
    expect(h.supervisorExecute).toHaveBeenCalledOnce();

    expect(h.d1Decide).toHaveBeenCalledOnce();
    expect(h.runtime.execute).toHaveBeenCalledOnce();
    expect(h.worktrees.createWorktree).toHaveBeenCalledOnce();
    expect(h.worktrees.captureResult).toHaveBeenCalledTimes(2);
    expect(h.reviewer.conductReview).toHaveBeenCalledTimes(2);
    expect(h.reviewer.ensureIndependentReview).toHaveBeenCalledTimes(2);
    expect(h.corrector.executeCorrection).toHaveBeenCalledOnce();
    expect(h.integrator.integrate).toHaveBeenCalledOnce();
    expect(h.gates.executeAll).toHaveBeenCalledOnce();
    expect(h.preview.deliver).not.toHaveBeenCalled();

    const persisted = await h.supervisorRepository.findDagById(result.dag.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("COMPLETED");
    expect(Object.values(persisted?.nodes ?? {}).map((node) => node.status)).toEqual(["SUCCEEDED"]);
    expect(result.dag).toEqual(persisted);
    expect(result.executionResult.status).toBe("SUCCEEDED");
    expect(result.executionResult.dag).toEqual(persisted);

    const persistedMission = await h.missionRepository.findById(h.missionId);
    expect(persistedMission?.plan).toEqual(result.plan);
    expect(persistedMission?.status).toBe("COMPLETED");
    expectNoIrreversibleAction(h.irreversible);
  });

  it.each([
    ["missing Mission", { mission: "MISSING" as const }, "mission_unavailable", undefined],
    [
      "cross-tenant Mission",
      { mission: "CROSS_TENANT" as const },
      "mission_unavailable",
      undefined,
    ],
    [
      "missing MissionContext",
      { context: "MISSING" as const },
      "mission_context_unavailable",
      undefined,
    ],
    [
      "invalid SelfStateSnapshot",
      { selfState: "INVALID" as const },
      "self_state_invalid",
      undefined,
    ],
    [
      "missing capability evidence",
      { capability: "MISSING" as const },
      undefined,
      "PROVIDER_UNAVAILABLE",
    ],
    [
      "APPROVAL_REQUIRED",
      { capability: "APPROVAL_REQUIRED" as const },
      undefined,
      "WAITING_FOR_APPROVAL",
    ],
    ["DENIED", { capability: "DENIED" as const }, undefined, "BLOCKED_BY_POLICY"],
    ["UNAVAILABLE", { capability: "UNAVAILABLE" as const }, undefined, "PROVIDER_UNAVAILABLE"],
  ])("fails closed before DAG creation for %s", async (_label, options, reason, outcome) => {
    const h = await createHarness(options);
    const result = await h.result();

    if (reason) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    } else {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.outcome).toBe(outcome);
    }
    expect(await h.supervisorRepository.findDagsByMissionId(h.missionId)).toEqual([]);
    expect(h.supervisorExecute).not.toHaveBeenCalled();
    expect(h.worktrees.createWorktree).not.toHaveBeenCalled();
    expect(h.reviewer.conductReview).not.toHaveBeenCalled();
    expect(h.corrector.executeCorrection).not.toHaveBeenCalled();
    expect(h.integrator.integrate).not.toHaveBeenCalled();
    expect(h.gates.executeAll).not.toHaveBeenCalled();
    expectNoIrreversibleAction(h.irreversible);
  });

  it("fails closed on real Supervisor failure and leaves partial persistence observable", async () => {
    const h = await createHarness({ runtime: "FAILED" });
    const result = await h.result();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("supervisor_execution_failed");
    expect(h.supervisorExecute).toHaveBeenCalledOnce();
    expect(h.d1Decide).toHaveBeenCalledOnce();
    expect(h.runtime.execute).toHaveBeenCalledOnce();
    expect(h.worktrees.createWorktree).toHaveBeenCalledOnce();

    const dags = await h.supervisorRepository.findDagsByMissionId(h.missionId);
    expect(dags).toHaveLength(1);
    expect(dags[0]?.status).toBe("FAILED");
    expect(Object.values(dags[0]?.nodes ?? {}).map((node) => node.status)).toEqual(["FAILED"]);
    expect((await h.missionRepository.findById(h.missionId))?.status).toBe("FAILED");
    expect(h.integrator.integrate).not.toHaveBeenCalled();
    expectNoIrreversibleAction(h.irreversible);
  });

  it("checks canonical Mission transition results and stops when a transition is rejected", async () => {
    const h = await createHarness();
    h.transitionStatus.mockResolvedValueOnce({
      ok: false,
      reason: "invalid_transition",
      message: "deterministic rejection",
    });

    const result = await h.result();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mission_transition_failed");
    expect(h.setPlan).not.toHaveBeenCalled();
    expect(h.supervisorExecute).not.toHaveBeenCalled();
    expect(await h.supervisorRepository.findDagsByMissionId(h.missionId)).toEqual([]);
    expect((await h.missionRepository.findById(h.missionId))?.status).toBe("CREATED");
    expectNoIrreversibleAction(h.irreversible);
  });

  it("fails closed with terminal DAG evidence when Mission completion is rejected", async () => {
    const h = await createHarness();
    h.transitionStatus.mockImplementation(async (input) => {
      if (input.targetStatus === "COMPLETED") {
        return {
          ok: false,
          reason: "invalid_transition",
          message: "deterministic completion rejection",
        };
      }
      return h.transitionStatusCanonical(input);
    });

    const result = await h.result();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mission_transition_failed");
    expect(result.mission?.status).toBe("IN_PROGRESS");
    expect(result.dag?.status).toBe("COMPLETED");
    expect(
      Object.values(result.dag?.nodes ?? {}).every((node) => node.status === "SUCCEEDED"),
    ).toBe(true);
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);
    expect((await h.missionRepository.findById(h.missionId))?.status).toBe("IN_PROGRESS");
    expectNoIrreversibleAction(h.irreversible);
  });

  it("retains real Supervisor failure when the Mission FAILED transition is rejected", async () => {
    const h = await createHarness({ runtime: "FAILED" });
    h.transitionStatus.mockImplementation(async (input) => {
      if (input.targetStatus === "FAILED") {
        return {
          ok: false,
          reason: "invalid_transition",
          message: "deterministic failure-transition rejection",
        };
      }
      return h.transitionStatusCanonical(input);
    });

    const result = await h.result();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("supervisor_execution_failed");
    expect(result.message).toMatch(/Supervisor.*FAILED.*également échoué/);
    expect(result.mission?.status).toBe("IN_PROGRESS");
    expect(result.dag?.status).toBe("FAILED");
    expect((await h.missionRepository.findById(h.missionId))?.status).toBe("IN_PROGRESS");
    expectNoIrreversibleAction(h.irreversible);
  });

  it.each([
    ["missing persisted DAG", { persistedRead: "MISSING" as const }],
    ["persisted DAG not COMPLETED", { persistedRead: "NOT_COMPLETED" as const }],
    ["persisted node not SUCCEEDED", { persistedRead: "NODE_NOT_SUCCEEDED" as const }],
    ["returned DAG contradicts persistence", { returned: "DAG_FAILED" as const }],
  ])("rejects canonical Supervisor inconsistency: %s", async (_label, options) => {
    const h = await createHarness(options);
    const result = await h.result();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("supervisor_state_inconsistent");
    expect(h.supervisorExecute).toHaveBeenCalledOnce();
    expect(h.integrator.integrate).toHaveBeenCalledOnce();
    expect(h.gates.executeAll).toHaveBeenCalledOnce();
    expect((await h.missionRepository.findById(h.missionId))?.status).toBe("IN_PROGRESS");
    expectNoIrreversibleAction(h.irreversible);
  });

  it("rejects integration-only success when returned Supervisor status is inconsistent", async () => {
    const h = await createHarness({ returned: "STATUS_FAILED" });
    const result = await h.result();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("supervisor_execution_failed");
    const persisted = await h.supervisorRepository.findDagsByMissionId(h.missionId);
    expect(persisted[0]?.status).toBe("COMPLETED");
    expect(h.integrator.integrate).toHaveBeenCalledOnce();
    expect(h.gates.executeAll).toHaveBeenCalledOnce();
    expectNoIrreversibleAction(h.irreversible);
  });
});
