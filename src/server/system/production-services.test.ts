import { describe, expect, it, vi } from "vitest";

import type { Env } from "@/config/env";
import type { Container } from "@/server/container";
import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { COMPUTE_HEALTH_OBSERVATION } from "@/server/proactive/compose";
import { enqueueObservation } from "@/server/proactive/observations";
import { modelAllowlist } from "@/core/autonomy/model-allowlist";
import { autonomyIgniteDeps, startProductionServices } from "@/server/system/production-services";
import {
  enqueueWorkerProbeSweep,
  nextOccurrenceAt,
  resolveProbeIntervalMs,
} from "@/server/workers/probes/worker-probe-schedule";

/*
 * The real container always constructs `scheduledJobs` (non-optional in Container),
 * so a stub without it is under-specified, not a supported composition. A REAL
 * in-memory repository is used rather than a mock so that M6 ignition is observed
 * through durable rows instead of through a call assertion.
 */
const jobs = () => new InMemoryScheduledJobRepository();

function env(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "production",
    PERSISTENCE: "postgres",
    DATABASE_URL: "postgres://localhost/icos",
    AUTONOMY_RECOVERY_INTERVAL_MS: 5_000,
    ...overrides,
  };
}

describe("production services bootstrap", () => {
  const signals = {
    onSignal: vi.fn(),
    removeSignal: vi.fn(),
    exit: vi.fn(),
  };

  it("starts PostgreSQL recovery scheduling and stops it before the container", async () => {
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const schedulerFactory = vi.fn().mockReturnValue({ start, stop });
    const container = {
      autonomousRuntime: {},
      scheduledJobs: jobs(),
      close,
    } as unknown as Container;

    const services = await startProductionServices({
      env: env(),
      createContainer: vi.fn().mockResolvedValue(container),
      schedulerFactory,
      signals,
    });

    expect(schedulerFactory).toHaveBeenCalledTimes(1);
    expect(schedulerFactory).toHaveBeenCalledWith(container, {
      intervalMs: 5_000,
      /* Absent ICOS_SELF_DEVELOPMENT must mean OFF: ICOS never self-modifies by default. */
      selfDevelopment: false,
    });
    expect(start).toHaveBeenCalledTimes(1);

    await services.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);

    await services.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails closed and closes the container if scheduler startup fails", async () => {
    const failure = new Error("SCHEDULER_START_FAILED");
    const close = vi.fn().mockResolvedValue(undefined);
    const container = {
      autonomousRuntime: {},
      scheduledJobs: jobs(),
      close,
    } as unknown as Container;

    await expect(
      startProductionServices({
        env: env(),
        createContainer: vi.fn().mockResolvedValue(container),
        schedulerFactory: vi.fn().mockReturnValue({
          start: vi.fn(() => {
            throw failure;
          }),
          stop: vi.fn(),
        }),
        signals,
      }),
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not start durable recovery outside PostgreSQL production", async () => {
    const schedulerFactory = vi.fn();
    const memoryContainer = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Container;
    const developmentContainer = {
      autonomousRuntime: {},
      scheduledJobs: jobs(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Container;

    const memoryServices = await startProductionServices({
      env: env({ NODE_ENV: "development", PERSISTENCE: "memory" }),
      createContainer: vi.fn().mockResolvedValue(memoryContainer),
      schedulerFactory,
      signals,
    });
    const developmentServices = await startProductionServices({
      env: env({ NODE_ENV: "development" }),
      createContainer: vi.fn().mockResolvedValue(developmentContainer),
      schedulerFactory,
      signals,
    });

    expect(schedulerFactory).not.toHaveBeenCalled();

    await memoryServices.stop();
    await developmentServices.stop();
  });

  it("fails closed if production PostgreSQL composition lacks a durable runtime", async () => {
    const close = vi.fn().mockResolvedValue(undefined);

    await expect(
      startProductionServices({
        env: env(),
        createContainer: vi.fn().mockResolvedValue({ close } as unknown as Container),
        schedulerFactory: vi.fn(),
        signals,
      }),
    ).rejects.toThrow("AUTONOMY_RECOVERY_RUNTIME_UNAVAILABLE");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops on a process signal and removes both shutdown handlers", async () => {
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const testSignals = {
      onSignal: vi.fn(),
      removeSignal: vi.fn(),
      exit: vi.fn(),
    };
    const services = await startProductionServices({
      env: env(),
      createContainer: vi.fn().mockResolvedValue({
        autonomousRuntime: {},
        scheduledJobs: jobs(),
        close,
      } as unknown as Container),
      schedulerFactory: vi.fn().mockReturnValue({ start, stop }),
      signals: testSignals,
    });
    const handlers = new Map(
      testSignals.onSignal.mock.calls as Array<["SIGINT" | "SIGTERM", () => void]>,
    );

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(testSignals.exit).toHaveBeenCalledWith(143);
    });

    expect(testSignals.removeSignal).toHaveBeenCalledTimes(2);

    await services.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  /*
   * M6 IGNITION — defect 16, one level up.
   *
   * The `probe_workers` chain perpetuates itself, but a self-perpetuating chain with
   * no first link never runs. Before this, `createSchedulerHandlers` was wired with a
   * prober and NOTHING ever enqueued a probe_workers job, so a fresh deployment never
   * probed: all health evidence expired, every worker became ineligible, and the fleet
   * refused every task while looking like a routing defect.
   */
  it("IGNITES worker probing: a fresh deployment has a due first sweep", async () => {
    const scheduledJobs = jobs();
    const close = vi.fn().mockResolvedValue(undefined);

    await startProductionServices({
      env: env(),
      createContainer: vi
        .fn()
        .mockResolvedValue({ autonomousRuntime: {}, scheduledJobs, close } as unknown as Container),
      schedulerFactory: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
      signals,
    });

    // The occurrence exists, at the grid instant — re-enqueueing it creates nothing.
    const at = nextOccurrenceAt(new Date(), resolveProbeIntervalMs(undefined));
    expect((await enqueueWorkerProbeSweep(scheduledJobs, at)).created).toBe(false);
  });

  /*
   * Decision 0055: the Proactive Supervisor's compute-health observation is ignited on
   * the canonical scheduler at boot — a handler nobody enqueues would never observe.
   * Without a database there is no supervisor (never a silent in-memory one).
   */
  it("IGNITES the compute-health observation when PostgreSQL is composed, idempotently", async () => {
    const boot = (scheduledJobs: InMemoryScheduledJobRepository, db: unknown) =>
      startProductionServices({
        env: env(),
        createContainer: vi.fn().mockResolvedValue({
          autonomousRuntime: {},
          scheduledJobs,
          db,
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as Container),
        schedulerFactory: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
        signals,
      });
    const at = nextOccurrenceAt(new Date(), COMPUTE_HEALTH_OBSERVATION.intervalMs);

    const withoutDb = jobs();
    await boot(withoutDb, undefined);
    expect((await enqueueObservation(withoutDb, COMPUTE_HEALTH_OBSERVATION, at)).created).toBe(
      true,
    );

    const withDb = jobs();
    await boot(withDb, {});
    await boot(withDb, {});
    expect((await enqueueObservation(withDb, COMPUTE_HEALTH_OBSERVATION, at)).created).toBe(false);
  });

  it("IGNITION IS IDEMPOTENT: two boots (or two replicas) yield ONE chain", async () => {
    const scheduledJobs = jobs();
    const boot = () =>
      startProductionServices({
        env: env(),
        createContainer: vi.fn().mockResolvedValue({
          autonomousRuntime: {},
          scheduledJobs,
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as Container),
        schedulerFactory: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
        signals,
      });

    await boot();
    await boot();

    /*
     * Grid alignment is what makes this hold: both boots computed the SAME instant and
     * therefore the same idempotency key. With a `now + interval` successor the second
     * boot would have minted a second, slightly offset chain, doubling probing forever
     * with neither chain able to detect the other.
     */
    const at = nextOccurrenceAt(new Date(), resolveProbeIntervalMs(undefined));
    expect((await enqueueWorkerProbeSweep(scheduledJobs, at)).created).toBe(false);

    // And exactly ONE occurrence is claimable, not two.
    await enqueueWorkerProbeSweep(scheduledJobs, new Date(Date.now() - 1_000));
    expect(await scheduledJobs.claimDue("a", 30_000)).not.toBeNull();
    expect(await scheduledJobs.claimDue("b", 30_000)).toBeNull();
  });

  it("a FAILED ignition aborts startup rather than running a fleet that cannot take work", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);

    await expect(
      startProductionServices({
        env: env(),
        createContainer: vi.fn().mockResolvedValue({
          autonomousRuntime: {},
          scheduledJobs: {
            enqueue: vi.fn(async () => {
              throw new Error("DB_DOWN");
            }),
          },
          close,
        } as unknown as Container),
        schedulerFactory: vi.fn().mockReturnValue({ start: vi.fn(), stop }),
        signals,
      }),
    ).rejects.toThrow("DB_DOWN");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("self-development runs ONLY when the owner enables it explicitly", async () => {
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const schedulerFactory = vi.fn().mockReturnValue({ start, stop });
    const container = {
      autonomousRuntime: {},
      scheduledJobs: jobs(),
      close,
    } as unknown as Container;

    const services = await startProductionServices({
      env: env({ ICOS_SELF_DEVELOPMENT: "enabled" }),
      createContainer: vi.fn().mockResolvedValue(container),
      schedulerFactory,
      signals,
    });

    expect(schedulerFactory).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ selfDevelopment: true }),
    );

    await services.stop();
  });

  it("an explicit `disabled` keeps self-development off", async () => {
    const schedulerFactory = vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() });
    const container = {
      autonomousRuntime: {},
      scheduledJobs: jobs(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Container;

    const services = await startProductionServices({
      env: env({ ICOS_SELF_DEVELOPMENT: "disabled" }),
      createContainer: vi.fn().mockResolvedValue(container),
      schedulerFactory,
      signals,
    });

    expect(schedulerFactory).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ selfDevelopment: false }),
    );

    await services.stop();
  });
});
describe("autonomyIgniteDeps — le câblage de la politique bornée", () => {
  /*
   * LE CÂBLAGE EST LA LIVRAISON (P0-E/P0-F). Ce test échoue si quelqu'un retire
   * `container.autonomyPolicy` de l'allumage : le plafond configuré et le pool de
   * compute autorisé n'auraient alors plus aucun appelant, donc n'appliqueraient rien.
   */
  it("transporte le plafond ET le pool de compute du conteneur jusqu'à l'allumage", () => {
    const policy = {
      options: { maxCycles: 20, maxRuntimeMs: 1_800_000, maxStagnationCycles: 2, maxReplans: 2 },
      systemModelAllowlist: modelAllowlist(["cheap-model"]),
      plannerCompute: { modelId: "cheap-model", providerId: "omniroute" },
    };

    const deps = autonomyIgniteDeps(
      {
        mission: {} as never,
        autonomousRuntime: {} as never,
        autonomousPlanner: undefined,
        autonomyPolicy: policy,
      } as unknown as Container,
      {} as never,
    );

    expect(deps.options).toEqual(policy.options);
    expect(deps.systemModelAllowlist).toEqual(policy.systemModelAllowlist);
    expect(deps.plannerCompute).toEqual(policy.plannerCompute);
  });

  it("reste fermé sans planificateur : jamais un plan inventé", async () => {
    const deps = autonomyIgniteDeps(
      {
        mission: {} as never,
        autonomousRuntime: {} as never,
        autonomousPlanner: undefined,
        autonomyPolicy: {},
      } as unknown as Container,
      {} as never,
    );

    await expect(deps.planner.plan({} as never)).rejects.toThrow("AUTONOMY_PLANNER_UNAVAILABLE");
  });
});
