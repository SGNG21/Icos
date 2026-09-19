import type { Env } from "@/config/env";
import { AutonomyRecoveryScheduler } from "@/server/autonomy/autonomy-recovery-scheduler";
import { AutonomyRecoverySweeper } from "@/server/autonomy/autonomy-recovery-sweeper";
import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";
import { createContainer as createApplicationContainer, type Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";
import { CombinedAutonomyRecoverySweeper } from "@/server/autonomy/combined-autonomy-recovery-sweeper";
import { loadEnv } from "@/config/env";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { sweepWithScheduler } from "@/server/scheduler/scheduler-sweeper";

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

function createRecoveryScheduler(
  container: Container,
  options: { intervalMs: number },
): ProductionServiceScheduler {
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
  );
  const wakeup = new AutonomyWakeupService(
    container.mission,
    supervisor,
    container.autonomousRuntime,
    undefined,
    container.autonomousPlanner,
  );
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
  });
  const durableScheduler = new DurableScheduler(container.scheduledJobs, handlers, {
    leaseMs: loadEnv().SCHEDULER_LEASE_MS,
  });

  return new AutonomyRecoveryScheduler(sweepWithScheduler(recovery, durableScheduler), options);
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
