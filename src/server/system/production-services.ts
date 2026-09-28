import type { Env } from "@/config/env";
import { AutonomyRecoveryScheduler } from "@/server/autonomy/autonomy-recovery-scheduler";
import { AutonomyRecoverySweeper } from "@/server/autonomy/autonomy-recovery-sweeper";
import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";
import { createContainer as createApplicationContainer, type Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { DurableImprovementBacklog } from "@/server/autonomy/durable-improvement-backlog";
import { SelfDevelopmentChain } from "@/server/autonomy/self-development-chain";
import { GovernedSelfDevelopmentCoordinator } from "@/server/autonomy/governed-self-development-coordinator";
import { CertifiedRuntimeExecutionHandoff } from "@/server/autonomy/certified-runtime-execution-handoff";
import { CanonicalIndependentReview } from "@/server/autonomy/canonical-independent-review";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";
import { CombinedAutonomyRecoverySweeper } from "@/server/autonomy/combined-autonomy-recovery-sweeper";
import { loadEnv } from "@/config/env";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { seedWorkerProbeSweep } from "@/server/workers/probes/worker-probe-schedule";
import { sweepWithScheduler } from "@/server/scheduler/scheduler-sweeper";
import { composeRuntimeRecovery } from "@/server/recovery/compose-runtime-recovery";
import { TemporalWorkflowProbe } from "@/server/recovery/temporal-workflow-probe";
import { sweepAll } from "@/server/recovery/sweep-all";

export interface ProductionServiceScheduler {
  start(): void;
  stop(): Promise<void>;
}

export interface ProductionServices {
  container: Container;
  stop(): Promise<void>;
}

export type ProductionServiceSignal = "SIGINT" | "SIGTERM";

export interface ProductionServiceSignals {
  onSignal(signal: ProductionServiceSignal, listener: () => void): void;
  removeSignal(signal: ProductionServiceSignal, listener: () => void): void;
  exit(code: number): void;
}

export interface StartProductionServicesOptions {
  env: Env;
  createContainer?: (options: { env: Env }) => Promise<Container>;
  schedulerFactory?: (
    container: Container,
    options: { intervalMs: number },
  ) => ProductionServiceScheduler;
  signals?: ProductionServiceSignals;
  registerSignals?: boolean;
}

const DEFAULT_AUTONOMY_RECOVERY_INTERVAL_MS = 30_000;

const PROCESS_SIGNALS: ProductionServiceSignals = {
  onSignal: (signal, listener) => {
    process.on(signal, listener);
  },
  removeSignal: (signal, listener) => {
    process.off(signal, listener);
  },
  exit: (code) => {
    process.exit(code);
  },
};

/**
 * THE production autonomy composition (M9, defect 23).
 *
 * Extracted from `createRecoveryScheduler` so that the runtime and its proofs use the SAME
 * function. Before this, the supervisor existed only inside the scheduler factory, so any
 * end-to-end proof had to hand-build one — and a hand-built composition is exactly how
 * defects 22 and 23 stayed invisible: the test wired what the container did not.
 *
 * Nothing here is test-only. `createRecoveryScheduler` calls it, and so does the
 * certification proof.
 */
export function composeAutonomyRuntime(container: Container): {
  supervisor: SupervisorService;
  qualityControl: QualityControlService;
  wakeup: AutonomyWakeupService;
  backlog: DurableImprovementBacklog;
  selfDevelopmentChain: SelfDevelopmentChain;
  selfDevelopment: GovernedSelfDevelopmentCoordinator;
} {
  if (!container.autonomousRuntime) {
    throw new Error("AUTONOMY_RECOVERY_RUNTIME_UNAVAILABLE");
  }

  const qualityControl = new QualityControlService({
    missions: container.mission,
    tasks: container.tasks,
    executionResults: container.executionResults,
    reviewer: container.reviewer,
    reviewDecisions: container.reviewDecisions,
    dispatchAttempts: container.dispatchAttempts,
    qualityJobs: container.qualityControlJobs,
    /*
     * M7.1 — QC retries are ROUTED. Without this the retry attempt carried no worker,
     * so an external worker dispatcher could not execute it and failed it closed,
     * burning a retry budget on a fleet problem. Same router instance the supervisor
     * uses: one authority, two callers.
     */
    capabilityRouter: container.capabilityRouter,
    dispatchPrepared: async (prepared, signal) => {
      const result = await container.taskExecution.dispatch({
        missionId: prepared.missionId,
        taskId: prepared.taskId,
        taskTitle: (await container.mission.getMissionTaskById(prepared.missionTaskId))?.title,
        prompt: prepared.prompt,
        workflowId: prepared.workflowId,
        workerKind: prepared.workerKind,
        capability: prepared.capability,
        digitalosFacadePath: loadEnv().DIGITALOS_FACADE_PATH,
        signal,
      });
      if (result.workflowId !== prepared.workflowId) {
        throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
      }
      signal?.throwIfAborted();
      await container.dispatchAttempts.markDispatched(prepared.id);
    },
  });
  const supervisor = new SupervisorService(
    container.mission,
    container.tasks,
    container.taskExecution,
    container.durableMemory,
    container.dispatchAttempts,
    /*
     * M9, defect 23: the GOVERNED path is now the default in production.
     *
     * This argument was `undefined`, so the supervisor's workspace branch was dead code in
     * every real deployment: an ordinary autonomous writer task dispatched with no
     * registered workspace, the external executor fell back to an ad-hoc worktree, and its
     * branch was never reviewed, integrated or reaped. Passing the coordinator is what
     * makes allocation happen during normal attempt preparation.
     */
    container.workspaceExecutionCoordinator,
    container.capabilityRouter,
  );
  const wakeup = new AutonomyWakeupService(
    container.mission,
    supervisor,
    container.autonomousRuntime,
    undefined,
    container.autonomousPlanner,
  );
  /*
   * SELF-DEVELOPMENT, composed in the REAL runtime (M11, defect 25 link 3).
   *
   * This is the FOURTH capability that was fully built, fully proven, and never wired — so it
   * is composed HERE, in the same function that builds the supervisor, and asserted by a
   * composition test rather than left to care.
   *
   * Every authority it uses is the canonical one: the durable backlog, the canonical goal
   * repository, `igniteAutonomousMission` for mission + plan + DAG, and — critically — an
   * execution handoff that ENTERS this very supervisor. There is no second planner, mission
   * engine, dispatcher, reviewer or integration authority anywhere in this graph.
   */
  const backlog = new DurableImprovementBacklog(container.durableMemory);

  const selfDevelopmentChain = new SelfDevelopmentChain({
    backlog,
    goals: container.goalRepository,
    ignite: {
      missions: container.mission,
      runtimeRepository: container.autonomousRuntime,
      supervisor,
      planner: container.autonomousPlanner ?? {
        async plan() {
          /* Fail closed: never invent a plan for work ICOS proposed to itself. */
          throw new Error("AUTONOMY_PLANNER_UNAVAILABLE");
        },
      },
    },
  });

  const selfDevelopment = new GovernedSelfDevelopmentCoordinator({
    backlog,
    missions: container.mission,
    dispatchAttempts: container.dispatchAttempts,
    workerRegistry: container.workerRegistry,
    /* THE adapter that enters the certified path — not a parallel execution handoff. */
    execution: new CertifiedRuntimeExecutionHandoff({
      supervisor,
      workspaces: container.workspaceManager!,
      dispatchAttempts: container.dispatchAttempts,
      executionResults: container.executionResults,
    }),
    /* The canonical reviewer, with the existing independence rule. Not a second authority. */
    review: new CanonicalIndependentReview({
      reviewer: container.reviewer,
      workerRegistry: container.workerRegistry,
      missions: container.mission,
      tasks: container.tasks,
    }),
    integrationGate: container.integrationGate!,
    integrationApplier: container.integrationApplier,
    workspaces: container.workspaceManager,
    durableMemory: container.durableMemory,
  });

  return { supervisor, qualityControl, wakeup, backlog, selfDevelopmentChain, selfDevelopment };
}

function createRecoveryScheduler(
  container: Container,
  options: { intervalMs: number },
): ProductionServiceScheduler {
  const { supervisor, qualityControl, wakeup } = composeAutonomyRuntime(container);
  if (!container.autonomousRuntime) {
    throw new Error("AUTONOMY_RECOVERY_RUNTIME_UNAVAILABLE");
  }

  const autonomySweeper = new AutonomyRecoverySweeper(container.autonomousRuntime, wakeup);
  const qualitySweeper = new QualityControlRecoverySweeper(
    qualityControl,
    container.qualityControlJobs,
    (missionId) => wakeup.wake(missionId),
  );
  const recovery = new CombinedAutonomyRecoverySweeper(autonomySweeper, qualitySweeper);

  // Durable Scheduler (ADR-0025): the same timer only triggers a consultation of the
  // durable job table; PostgreSQL stays the source of truth.
  const planner = container.autonomousPlanner;
  const handlers = createSchedulerHandlers({
    ignite: {
      missions: container.mission,
      runtimeRepository: container.autonomousRuntime,
      supervisor,
      // Fail closed without a planner: the mission stays `running` and recovery keeps
      // retrying planning once configured (never a false success).
      planner: planner ?? {
        async plan() {
          throw new Error("AUTONOMY_PLANNER_UNAVAILABLE");
        },
      },
    },
    missions: container.mission,
    wakeup,
    /*
     * M6: autonomous worker probing. The recurrence lives in `scheduled_jobs`, so
     * exactly one process sweeps at a time and it survives a restart — a
     * setInterval here would probe once per replica and vanish on restart.
     */
    workerProbe: {
      prober: container.workerHealthProber,
      jobs: container.scheduledJobs,
      intervalMs: loadEnv().ICOS_WORKER_PROBE_INTERVAL_MS,
    },
  });
  const durableScheduler = new DurableScheduler(container.scheduledJobs, handlers, {
    leaseMs: loadEnv().SCHEDULER_LEASE_MS,
  });

  // Runtime Recovery 7C (ADR-0027): orphan detection beyond running runtimes (settled `waiting`, stale
  // prepared/dispatched attempts). PostgreSQL-only; the scheduler + existing sweepers above are untouched.
  const env = loadEnv();
  const runtimeRecovery = container.db
    ? composeRuntimeRecovery({
        db: container.db,
        wakeup,
        supervisor,
        dispatcher: container.taskExecution,
        missions: container.mission,
        executionResults: container.executionResults,
        dispatchAttempts: container.dispatchAttempts,
        digitalosFacadePath: env.DIGITALOS_FACADE_PATH,
        probe: new TemporalWorkflowProbe(env.TEMPORAL_ADDRESS, env.TEMPORAL_DISPATCH_TIMEOUT_MS),
      })
    : null;

  return new AutonomyRecoveryScheduler(
    sweepAll([
      ["autonomy-and-scheduler", sweepWithScheduler(recovery, durableScheduler)],
      ...(runtimeRecovery ? [["runtime-recovery", runtimeRecovery] as const] : []),
    ]),
    options,
  );
}

/**
 * Explicit process-level lifecycle for long-lived production services.
 * Container construction remains side-effect free: scheduling starts only here.
 */
export async function startProductionServices(
  options: StartProductionServicesOptions,
): Promise<ProductionServices> {
  const createContainer = options.createContainer ?? createApplicationContainer;
  const schedulerFactory = options.schedulerFactory ?? createRecoveryScheduler;
  const container = await createContainer({ env: options.env });
  let scheduler: ProductionServiceScheduler | null = null;

  try {
    if (options.env.NODE_ENV === "production" && options.env.PERSISTENCE === "postgres") {
      if (!container.autonomousRuntime) {
        throw new Error("AUTONOMY_RECOVERY_RUNTIME_UNAVAILABLE");
      }

      scheduler = schedulerFactory(container, {
        intervalMs:
          options.env.AUTONOMY_RECOVERY_INTERVAL_MS ?? DEFAULT_AUTONOMY_RECOVERY_INTERVAL_MS,
      });
      scheduler.start();

      /*
       * M6 defect 16: IGNITE worker probing. The `probe_workers` chain perpetuates
       * itself, but only once a first occurrence exists — without this, a fresh
       * deployment never probes, all health evidence expires, and the whole fleet
       * refuses every task while looking like a routing bug. Grid-aligned, so this
       * is a no-op when a chain is already alive and safe on every replica's boot.
       * A failure here must abort startup: silently running a fleet that can never
       * take work is worse than not starting.
       */
      await seedWorkerProbeSweep(container.scheduledJobs, {
        intervalMs: options.env.ICOS_WORKER_PROBE_INTERVAL_MS,
      });
    }
  } catch (error) {
    await container.close();
    throw error;
  }

  let stopPromise: Promise<void> | null = null;

  const signals = options.signals ?? PROCESS_SIGNALS;
  const signalNames: ProductionServiceSignal[] = ["SIGINT", "SIGTERM"];
  const signalListeners = new Map<ProductionServiceSignal, () => void>();
  let signalHandlersInstalled = false;
  let shutdownSignal: ProductionServiceSignal | null = null;

  const removeSignalHandlers = () => {
    if (!signalHandlersInstalled) {
      return;
    }

    for (const signal of signalNames) {
      const listener = signalListeners.get(signal);

      if (listener) {
        signals.removeSignal(signal, listener);
      }
    }

    signalListeners.clear();
    signalHandlersInstalled = false;
  };

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      removeSignalHandlers();
      await scheduler?.stop();
      await container.close();
    })();

    return stopPromise;
  };

  const onSignal = (signal: ProductionServiceSignal) => {
    if (shutdownSignal) {
      return;
    }

    shutdownSignal = signal;
    void stop()
      .then(() => {
        signals.exit(signal === "SIGINT" ? 130 : 143);
      })
      .catch((error: unknown) => {
        console.error("ICOS production service shutdown failed", error);
        signals.exit(1);
      });
  };

  if (scheduler && options.registerSignals !== false) {
    signalHandlersInstalled = true;

    for (const signal of signalNames) {
      const listener = () => onSignal(signal);
      signalListeners.set(signal, listener);
      signals.onSignal(signal, listener);
    }
  }

  return {
    container,
    stop,
  };
}
