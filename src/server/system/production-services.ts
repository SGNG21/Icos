import type { Env } from "@/config/env";
import { AutonomyRecoveryScheduler } from "@/server/autonomy/autonomy-recovery-scheduler";
import { AutonomyRecoverySweeper } from "@/server/autonomy/autonomy-recovery-sweeper";
import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";
import { createContainer as createApplicationContainer, type Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { CanonicalImprovementProposer } from "@/server/autonomy/canonical-improvement-proposer";
import { DurableImprovementBacklog } from "@/server/autonomy/durable-improvement-backlog";
import { SelfDevelopmentChain } from "@/server/autonomy/self-development-chain";
import { GovernedSelfDevelopmentCoordinator } from "@/server/autonomy/governed-self-development-coordinator";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";
import { CombinedAutonomyRecoverySweeper } from "@/server/autonomy/combined-autonomy-recovery-sweeper";
import { loadEnv } from "@/config/env";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { seedWorkerProbeSweep } from "@/server/workers/probes/worker-probe-schedule";
import { bootstrapComputeFleetAtStartup } from "@/server/workers/startup-compute-bootstrap";
import { COMPUTE_HEALTH_OBSERVATION, composeProactiveSupervisor } from "@/server/proactive/compose";
import { seedObservation } from "@/server/proactive/observations";
import { sweepWithScheduler } from "@/server/scheduler/scheduler-sweeper";
import { composeRuntimeRecovery } from "@/server/recovery/compose-runtime-recovery";
import { TemporalWorkflowProbe } from "@/server/recovery/temporal-workflow-probe";
import { sweepAll } from "@/server/recovery/sweep-all";
import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";
import { cognitiveLaunchRecoverySweeper } from "@/server/cognitive/launch-recovery-sweeper";
import { PendingReviewGateSweeper } from "@/server/workspace-manager/pending-review-gate-sweeper";

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
    options: { intervalMs: number; selfDevelopment: boolean },
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
  /** The QC + runtime recovery sweep of every production tick. */
  recovery: CombinedAutonomyRecoverySweeper;
  /** The ONLY production caller of `gatePendingReview()` (0045). */
  pendingReviewGate?: PendingReviewGateSweeper;
  backlog: DurableImprovementBacklog;
  selfDevelopmentChain: SelfDevelopmentChain;
  selfDevelopment: GovernedSelfDevelopmentCoordinator;
  /**
   * M14 — ICOS deciding WHAT to improve. Absent when no proposer compute is configured, and
   * absent means ICOS cannot start from an instruction: it never means "invent something".
   */
  improvementProposer?: CanonicalImprovementProposer;
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
    /*
     * NO `dispatchPrepared` (0050 × 0049). A CORRECT/RETRY prepares its attempt and sets the
     * durable wake-up in the SAME transaction; the woken supervisor claims that intent and
     * runs it on the GOVERNED path (workspace, review, gate, settlement). Dispatching it here
     * went straight to `taskExecution`: the correction got no workspace, stayed `dispatched`,
     * and the task never settled.
     *
     * Control admission (control command bus decision) therefore applies where the woken
     * supervisor claims the intent (`admissionHeld` in `run()` / `reconcilePreparedDispatches`),
     * not here.
     */
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
    /* Decision 0044: paused missions / safe mode admit no new work. */
    container.control?.guard,
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

  /*
   * THE PRODUCTION TICK, composed once (decision 0052). The recovery scheduler runs exactly
   * these sweepers on its timer; self-development drives the same ones while it waits for its
   * mission to settle. One review, gate and settlement authority — not a second pipeline.
   */
  const recovery = new CombinedAutonomyRecoverySweeper(
    new AutonomyRecoverySweeper(container.autonomousRuntime, wakeup),
    new QualityControlRecoverySweeper(qualityControl, container.qualityControlJobs, (missionId) =>
      wakeup.wake(missionId),
    ),
  );
  const pendingReviewGate = container.workspaceExecutionCoordinator
    ? new PendingReviewGateSweeper(container.workspaceExecutionCoordinator)
    : undefined;

  const selfDevelopment = new GovernedSelfDevelopmentCoordinator({
    backlog,
    missions: container.mission,
    tasks: container.tasks,
    /* THE JOIN (defect 29): the chain plans, the coordinator observes what it planned. */
    chain: selfDevelopmentChain,
    pass: {
      async run() {
        await recovery.sweep();
        const gated = await pendingReviewGate?.sweep();
        const workspaces = gated ? await container.workspaceManager!.list() : [];
        return (gated?.results ?? []).flatMap((r) =>
          r.decision
            ? [
                {
                  taskId: r.taskId,
                  decision: r.decision,
                  reasons: r.reasons ?? [],
                  commitSha:
                    workspaces.find((w) => w.workspaceId === r.workspaceId)?.sourceCommit ??
                    undefined,
                },
              ]
            : [],
        );
      },
    },
    executionResults: container.executionResults,
    reviewDecisions: container.reviewDecisions,
    workspaces: container.workspaceManager,
    durableMemory: container.durableMemory,
  });

  /*
   * M14 — the entry point for "improve yourself".
   *
   * Every self-development capability before this started from a candidate SOMEBODY ELSE had
   * written; nothing in ICOS produced one, so an empty backlog could only answer
   * NO_CANDIDATE. This proposes into the same durable backlog the chain already selects from,
   * so nothing downstream changes: policy, planning, governance, review and the gate all
   * judge a proposal exactly as they judge a human's.
   */
  const improvementProposer = container.improvementProposalProvider
    ? new CanonicalImprovementProposer({
        provider: container.improvementProposalProvider,
        backlog,
        repoPath: loadEnv().ICOS_REPO_PATH,
        timeoutMs: loadEnv().ICOS_PLANNER_TIMEOUT_MS ?? 300_000,
      })
    : undefined;

  return {
    supervisor,
    qualityControl,
    wakeup,
    recovery,
    pendingReviewGate,
    backlog,
    selfDevelopmentChain,
    selfDevelopment,
    improvementProposer,
  };
}

function createRecoveryScheduler(
  container: Container,
  options: { intervalMs: number; selfDevelopment: boolean },
): ProductionServiceScheduler {
  const { supervisor, wakeup, recovery, pendingReviewGate, selfDevelopment } =
    composeAutonomyRuntime(container);
  if (!container.autonomousRuntime) {
    throw new Error("AUTONOMY_RECOVERY_RUNTIME_UNAVAILABLE");
  }

  // Durable Scheduler (ADR-0025): the same timer only triggers a consultation of the
  // durable job table; PostgreSQL stays the source of truth.
  const planner = container.autonomousPlanner;
  const proactive = composeProactiveSupervisor(container);
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
    // Proactive Supervisor (decision 0060): observations ride this same durable scheduler.
    supervisorObservation: proactive
      ? {
          supervisor: proactive.supervisor,
          sources: proactive.sources,
          jobs: container.scheduledJobs,
        }
      : undefined,
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
        control: container.control?.guard,
      })
    : null;

  return new AutonomyRecoveryScheduler(
    sweepAll([
      ["autonomy-and-scheduler", sweepWithScheduler(recovery, durableScheduler)],
      ...(runtimeRecovery ? [["runtime-recovery", runtimeRecovery] as const] : []),
      /*
       * THE LATER GOVERNED PASS (defect 28 closure). After the QC sweep above has reviewed
       * recorded executions, gate every parked workspace whose canonical review now exists.
       * This is the ONLY production caller of `gatePendingReview()`; without it an approval
       * written after execution was never gated or integrated by the runtime.
       */
      ...(pendingReviewGate ? [["pending-review-gate", pendingReviewGate] as const] : []),
      /*
       * THE ONLY production caller of cognitive launch recovery. It used to fire from
       * `cognitiveRuntimeFor(...)` composition, so a plain GET on /api/cognitive/* could
       * relaunch an approved proposal and enqueue `start_mission`. Same authority, moved
       * onto this explicit timer: reads no longer execute anything.
       */
      ...(container.db
        ? [["cognitive-launch-recovery", cognitiveLaunchRecoverySweeper(container)] as const]
        : []),
      /*
       * THE ONLY production caller of governed self-development ("Améliore ICOS"). The
       * coordinator was composed but never invoked by anything, so the self-improvement loop
       * existed and could not start. It is attached to the SAME lifecycle timer rather than a
       * second scheduler: no new authority.
       *
       * OPT-IN, and absent means off. Putting ICOS's self-modification on a 30 s timer is the
       * largest autonomy increase in the system, so it stays the owner's switch
       * (`ICOS_SELF_DEVELOPMENT=enabled`), never a default acquired by deployment.
       */
      ...(options.selfDevelopment
        ? [
            [
              "self-development",
              {
                async sweep(): Promise<AutonomyRecoverySweepResult> {
                  const idle: AutonomyRecoverySweepResult = {
                    discovered: 0,
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    failures: [],
                  };
                  const outcome = await selfDevelopment.advance();
                  /* No candidate is the normal idle tick: nothing discovered, nothing attempted. */
                  /* L'union n'a pas de clé commune : on la discrimine par présence. */
                  if ("status" in outcome) return idle;
                  /*
                   * `policy_denied`, `gate_rejected` and `human_decision_required` are the
                   * governance WORKING, not errors: they are attempted-but-not-succeeded, and
                   * are deliberately NOT reported as `failed`, which is reserved for a thrown
                   * fault (sweepAll catches those). attempted > succeeded + failed is the signal.
                   */
                  return {
                    discovered: 1,
                    attempted: 1,
                    succeeded: outcome.finalState === "integrated" ? 1 : 0,
                    failed: 0,
                    failures: [],
                  };
                },
              },
            ] as const,
          ]
        : []),
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
        selfDevelopment: options.env.ICOS_SELF_DEVELOPMENT === "enabled",
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

      /*
       * Proactive Supervisor (decision 0060): ignite the compute-health observation,
       * same grid-aligned idempotent ignition as probing. Default policy for that domain
       * is NOTIFY and compute routing owns remediation, so this observes; it never acts.
       */
      if (container.db) await seedObservation(container.scheduledJobs, COMPUTE_HEALTH_OBSERVATION);

      /*
       * THE CANONICAL FLEET BOOTSTRAP (live-worker bootstrap lane). Probing was already
       * ignited above, but nothing ever REGISTERED the declared fleet outside an operator
       * CLI, so a deployment nobody ran it against probes an empty registry forever and
       * reads as a routing bug.
       *
       * Default OFF (ICOS_COMPUTE_BOOTSTRAP): registering writes to whatever database this
       * process resolved, which is an operator's decision, not an upgrade side effect.
       * Unlike the probe seeding above a failure here does NOT abort startup: an
       * unreachable provider leaves the registry exactly as it was, which is survivable,
       * whereas refusing to boot the whole runtime over it is not.
       */
      await bootstrapComputeFleetAtStartup(container, options.env);
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
