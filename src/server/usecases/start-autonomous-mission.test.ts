import { describe, expect, it, vi } from "vitest";

import type { Attribution } from "@/core/budget/contracts";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import { AUTONOMY_BOUNDS_CEILING } from "@/core/autonomy/bounds";
import { modelAllowlist } from "@/core/autonomy/model-allowlist";
import { currentAttribution } from "@/server/budget/attribution-context";
import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";
import type {
  AutonomousMissionPlanner,
  AutonomousSupervisor,
} from "@/server/autonomy/autonomous-mission-runner";
import {
  startAutonomousMission,
  type StartAutonomousMissionDeps,
} from "@/server/usecases/start-autonomous-mission";

const now = new Date("2026-10-02T12:00:00.000Z");

function mission(status: Mission["status"] = "succeeded"): Mission {
  return {
    id: "mission-bounds",
    title: "Bounded autonomy",
    objective: "Run one cheap bounded autonomous mission",
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function task(): MissionTask {
  return {
    id: "mission-task-1",
    missionId: "mission-bounds",
    taskId: "canonical-task-1",
    title: "Already planned",
    description: null,
    status: "succeeded",
    dependsOn: [],
    workerKind: "agent",
    capability: null,
  };
}

function runtime(overrides: Partial<AutonomousMissionRuntime> = {}): AutonomousMissionRuntime {
  return {
    missionId: "mission-bounds",
    state: "running",
    startedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: now,
    cycleCount: 0,
    replanCount: 0,
    stagnationCount: 0,
    maxCycles: 100,
    maxReplans: 5,
    maxRuntimeMs: 60 * 60 * 1000,
    maxStagnationCycles: 3,
    lastReason: "AUTONOMY_STARTED",
    ownerToken: null,
    leaseUntil: null,
    ...overrides,
  };
}

/**
 * Durable runtime fake. `existing === null` means a fresh mission, so
 * createIfAbsent captures exactly the bounds the use case resolved.
 */
function runtimeRepository(existing: AutonomousMissionRuntime | null = null) {
  const repository = {
    current: existing,
    create: vi.fn(),
    createIfAbsent: vi.fn().mockImplementation(async (next: AutonomousMissionRuntime) => {
      repository.current = next;

      return true;
    }),
    get: vi.fn().mockImplementation(async () => repository.current),
    listRecoverable: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockImplementation(async (next: AutonomousMissionRuntime) => {
      repository.current = next;
    }),
    saveOwned: vi.fn().mockImplementation(async (next: AutonomousMissionRuntime) => {
      repository.current = next;
    }),
    claim: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    renewClaim: vi.fn().mockResolvedValue(true),
  };

  return repository as typeof repository & AutonomousMissionRuntimeRepository;
}

function deps(
  repository: ReturnType<typeof runtimeRepository>,
  overrides: Partial<StartAutonomousMissionDeps> = {},
): StartAutonomousMissionDeps {
  const planner: AutonomousMissionPlanner = {
    plan: vi.fn().mockRejectedValue(new Error("PLANNER_MUST_NOT_RUN_IN_THIS_TEST")),
  };

  const supervisor: AutonomousSupervisor = {
    run: vi.fn().mockRejectedValue(new Error("SUPERVISOR_MUST_NOT_RUN_IN_THIS_TEST")),
    reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
    settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
  };

  return {
    missions: {
      findById: vi.fn().mockResolvedValue(mission()),
      listTasks: vi.fn().mockResolvedValue([task()]),
      applyPlan: vi.fn(),
      replacePlan: vi.fn(),
    },
    runtimeRepository: repository,
    supervisor,
    planner,
    now: () => now,
    ...overrides,
  };
}

function bounded(runtimeValue: AutonomousMissionRuntime | null) {
  return {
    maxCycles: runtimeValue?.maxCycles,
    maxRuntimeMs: runtimeValue?.maxRuntimeMs,
    maxStagnationCycles: runtimeValue?.maxStagnationCycles,
    maxReplans: runtimeValue?.maxReplans,
  };
}

describe("startAutonomousMission runtime bounds", () => {
  it("keeps the historical default bounds when nothing is requested", async () => {
    const repository = runtimeRepository();

    const result = await startAutonomousMission(deps(repository), {
      missionId: "mission-bounds",
    });

    expect(bounded(repository.createIfAbsent.mock.calls[0]?.[0])).toEqual(AUTONOMY_BOUNDS_CEILING);
    expect(bounded(repository.createIfAbsent.mock.calls[0]?.[0])).toEqual({
      maxCycles: 100,
      maxRuntimeMs: 60 * 60 * 1000,
      maxStagnationCycles: 3,
      maxReplans: 5,
    });
    expect(result.clampedBounds).toBeUndefined();
  });

  it("passes injected deps.options through untouched when nothing is requested", async () => {
    const repository = runtimeRepository();

    await startAutonomousMission(
      deps(repository, {
        options: { maxCycles: 2, maxRuntimeMs: 1_000, maxStagnationCycles: 1, maxReplans: 0 },
      }),
      { missionId: "mission-bounds" },
    );

    expect(bounded(repository.createIfAbsent.mock.calls[0]?.[0])).toEqual({
      maxCycles: 2,
      maxRuntimeMs: 1_000,
      maxStagnationCycles: 1,
      maxReplans: 0,
    });
  });

  it("carries a caller's narrowed bounds into the durable runtime", async () => {
    const repository = runtimeRepository();

    const result = await startAutonomousMission(deps(repository), {
      missionId: "mission-bounds",
      bounds: { maxCycles: 20, maxRuntimeMs: 30 * 60 * 1000, maxReplans: 2 },
    });

    expect(bounded(repository.createIfAbsent.mock.calls[0]?.[0])).toEqual({
      maxCycles: 20,
      maxRuntimeMs: 30 * 60 * 1000,
      maxStagnationCycles: 3,
      maxReplans: 2,
    });
    expect(result.clampedBounds).toBeUndefined();
  });

  it("clamps a widening request to the ceiling and reports it in the result", async () => {
    const repository = runtimeRepository();

    const result = await startAutonomousMission(deps(repository), {
      missionId: "mission-bounds",
      bounds: { maxCycles: 100_000, maxRuntimeMs: 24 * 60 * 60 * 1000, maxReplans: 1 },
    });

    expect(bounded(repository.createIfAbsent.mock.calls[0]?.[0])).toEqual({
      maxCycles: 100,
      maxRuntimeMs: 60 * 60 * 1000,
      maxStagnationCycles: 3,
      maxReplans: 1,
    });
    expect([...(result.clampedBounds ?? [])].sort()).toEqual(["maxCycles", "maxRuntimeMs"]);
  });

  it("clamps against injected deps.options when those are tighter than the policy ceiling", async () => {
    const repository = runtimeRepository();

    const result = await startAutonomousMission(
      deps(repository, {
        options: { maxCycles: 3, maxRuntimeMs: 5_000, maxStagnationCycles: 1, maxReplans: 0 },
      }),
      { missionId: "mission-bounds", bounds: { maxCycles: 50 } },
    );

    expect(repository.createIfAbsent.mock.calls[0]?.[0].maxCycles).toBe(3);
    expect(result.clampedBounds).toEqual(["maxCycles"]);
  });

  it("rejects an invalid requested bound instead of coercing it", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(deps(repository), {
        missionId: "mission-bounds",
        bounds: { maxCycles: 0 },
      }),
    ).rejects.toThrow(/AUTONOMY_BOUNDS_INVALID/);

    expect(repository.createIfAbsent).not.toHaveBeenCalled();
  });

  /*
   * The durable-runtime invariant: budgets are the runtime's own persisted
   * values. Re-igniting an existing runtime must never raise its caps.
   */
  it("cannot widen the caps of an already persisted runtime", async () => {
    const persisted = runtime({ cycleCount: 1, maxCycles: 1, maxReplans: 0 });
    const repository = runtimeRepository(persisted);

    const result = await startAutonomousMission(deps(repository), {
      missionId: "mission-bounds",
      bounds: { maxCycles: 100, maxRuntimeMs: 60 * 60 * 1000, maxReplans: 5 },
    });

    expect(repository.createIfAbsent).not.toHaveBeenCalled();
    expect(result.state).toBe("escalated");
    expect(result.reason).toBe("AUTONOMY_CYCLE_BUDGET_EXCEEDED");
    expect(bounded(repository.current)).toEqual({
      maxCycles: 1,
      maxRuntimeMs: 60 * 60 * 1000,
      maxStagnationCycles: 3,
      maxReplans: 0,
    });
  });

  it("still refuses to start an unknown mission", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(
        deps(repository, {
          missions: {
            findById: vi.fn().mockResolvedValue(null),
            listTasks: vi.fn(),
            applyPlan: vi.fn(),
            replacePlan: vi.fn(),
          },
        }),
        { missionId: "mission-bounds" },
      ),
    ).rejects.toThrow(/START_AUTONOMOUS_MISSION_NOT_FOUND/);
  });
});

/**
 * L'allumage est l'une des deux seules frontières qui connaissent le goal d'une mission.
 * Ce qui est prouvé ici : la portée est bien ouverte pendant `run` (observée depuis un appel
 * que le runner fait lui-même), elle porte le goal PERSISTÉ, elle est refermée à la sortie,
 * et une mission sans goal n'en reçoit pas une inventée.
 */
describe("startAutonomousMission — portée d'imputation de la dépense", () => {
  const observing = (repository: ReturnType<typeof runtimeRepository>, goalId?: string) => {
    const seen: (Attribution | null)[] = [];
    const base = deps(repository);

    return {
      seen,
      deps: {
        ...base,
        missions: {
          ...base.missions,
          findById: vi.fn().mockResolvedValue(goalId ? { ...mission(), goalId } : mission()),
          listTasks: vi.fn().mockImplementation(async () => {
            seen.push(currentAttribution());
            return [task()];
          }),
        },
      } satisfies StartAutonomousMissionDeps,
    };
  };

  it("impute au goal PERSISTÉ de la mission pendant toute l'exécution", async () => {
    const observer = observing(runtimeRepository(), "goal-7");

    await startAutonomousMission(observer.deps, { missionId: "mission-bounds" });

    expect(observer.seen.length).toBeGreaterThan(0);
    expect(observer.seen).toEqual(observer.seen.map(() => ({ goalId: "goal-7" })));
    /* La portée ne fuit pas hors de l'allumage. */
    expect(currentAttribution()).toBeNull();
  });

  it("n'invente aucune imputation pour une mission sans goal", async () => {
    const observer = observing(runtimeRepository());

    await startAutonomousMission(observer.deps, { missionId: "mission-bounds" });

    expect(observer.seen.length).toBeGreaterThan(0);
    expect(observer.seen).toEqual(observer.seen.map(() => null));
  });

  it("ignore un goalId soufflé par l'appelant : la mission persistée est l'autorité", async () => {
    const observer = observing(runtimeRepository());

    await startAutonomousMission(observer.deps, {
      missionId: "mission-bounds",
      goalId: "goal-du-caller",
    });

    expect(observer.seen).toEqual(observer.seen.map(() => null));
  });
});

describe("startAutonomousMission — politique de compute par goal (P0-F)", () => {
  /*
   * HEADLINE TEST. Un goal ne s'octroie JAMAIS une autorité que le système n'a pas
   * déjà accordée. Demander un modèle hors de l'ensemble système est REFUSÉ, pas
   * accordé, et la mission ne démarre pas.
   */
  it("REFUSES a goal asking for a model outside the system-allowed set", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(
        deps(repository, {
          systemModelAllowlist: modelAllowlist(["cheap-model"]),
          plannerCompute: { modelId: "expensive-model" },
        }),
        {
          missionId: "mission-bounds",
          computePolicy: { allowedModels: ["expensive-model"] },
        },
      ),
    ).rejects.toThrow(/START_AUTONOMOUS_MISSION_COMPUTE_REFUSED:modelIds:expensive-model/);

    /* Rien n'a été persisté : le refus précède tout effet de bord. */
    expect(repository.createIfAbsent).not.toHaveBeenCalled();
    expect(repository.current).toBeNull();
  });

  it("starts when the goal's pool is a SUBSET that covers the configured compute", async () => {
    const repository = runtimeRepository();

    const result = await startAutonomousMission(
      deps(repository, {
        systemModelAllowlist: modelAllowlist(["cheap-model", "expensive-model"]),
        plannerCompute: { modelId: "cheap-model" },
      }),
      { missionId: "mission-bounds", computePolicy: { allowedModels: ["cheap-model"] } },
    );

    expect(result.state).toBe("succeeded");
    expect(repository.createIfAbsent).toHaveBeenCalledTimes(1);
  });

  it("REFUSES when the configured compute is outside the goal's own pool", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(
        deps(repository, {
          systemModelAllowlist: modelAllowlist(["cheap-model", "expensive-model"]),
          plannerCompute: { modelId: "expensive-model" },
        }),
        { missionId: "mission-bounds", computePolicy: { allowedModels: ["cheap-model"] } },
      ),
    ).rejects.toThrow(/COMPUTE_REFUSED:MODEL_NOT_IN_ALLOWLIST/);
  });

  /* Fermé par défaut : un modèle inconnu/irrésoluble sous un goal restreint est REFUSÉ. */
  it("REFUSES a restricted goal when the configured compute declares no model", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(deps(repository, { plannerCompute: undefined }), {
        missionId: "mission-bounds",
        computePolicy: { allowedModels: ["cheap-model"] },
      }),
    ).rejects.toThrow(/COMPUTE_REFUSED:MODEL_ID_INVALID/);
  });

  it("REFUSES an empty goal pool rather than reading it as 'no restriction'", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(deps(repository, { plannerCompute: { modelId: "cheap-model" } }), {
        missionId: "mission-bounds",
        computePolicy: { allowedModels: [] },
      }),
    ).rejects.toThrow(/COMPUTE_REFUSED:MODEL_ALLOWLIST_EMPTY/);
  });

  it("enforces a SYSTEM allowlist even when the goal requests nothing", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(
        deps(repository, {
          systemModelAllowlist: modelAllowlist(["cheap-model"]),
          plannerCompute: { modelId: "something-else" },
        }),
        { missionId: "mission-bounds" },
      ),
    ).rejects.toThrow(/COMPUTE_REFUSED:MODEL_NOT_IN_ALLOWLIST/);
  });

  it("is byte-identical to the previous behaviour when neither side restricts anything", async () => {
    const repository = runtimeRepository();

    const result = await startAutonomousMission(deps(repository), {
      missionId: "mission-bounds",
    });

    expect(result.state).toBe("succeeded");
    expect(bounded(repository.current)).toEqual(AUTONOMY_BOUNDS_CEILING);
  });

  it("enforces the provider axis too", async () => {
    const repository = runtimeRepository();

    await expect(
      startAutonomousMission(
        deps(repository, {
          systemModelAllowlist: modelAllowlist(["cheap-model"], ["omniroute"]),
          plannerCompute: { modelId: "cheap-model", providerId: "autre-passerelle" },
        }),
        { missionId: "mission-bounds" },
      ),
    ).rejects.toThrow(/COMPUTE_REFUSED:PROVIDER_NOT_IN_ALLOWLIST/);
  });
});

describe("startAutonomousMission — la demande du propriétaire arrive (P0-E)", () => {
  it("persists EXACTLY 30 min / 20 cycles / 2 replans in the runtime row", async () => {
    const repository = runtimeRepository();

    await startAutonomousMission(deps(repository), {
      missionId: "mission-bounds",
      bounds: { maxRuntimeMs: 30 * 60 * 1000, maxCycles: 20, maxReplans: 2 },
    });

    expect(repository.current?.maxRuntimeMs).toBe(30 * 60 * 1000);
    expect(repository.current?.maxCycles).toBe(20);
    expect(repository.current?.maxReplans).toBe(2);
  });
});
