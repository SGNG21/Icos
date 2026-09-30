import { randomUUID } from "node:crypto";

import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import {
  WorkerCapacityExceededError,
  type DispatchAttempt,
  type DispatchAttemptRepository,
} from "@/core/contracts/dispatch-attempt";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { WorkspaceExecutionCoordinator } from "@/server/workspace-manager/workspace-execution-coordinator";

import type { CapabilityRouter } from "@/server/routing/capability-router";
import { complexityFromRisk } from "@/core/workers/compute-routing";

import type { RuntimeControlGuard } from "@/server/control/runtime-control";
import { computeReadyTasks } from "@/server/supervisor/readiness";
import { loadEnv } from "@/config/env";
import { loadMissionCheckpoint } from "@/server/usecases/load-mission-checkpoint";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import {
  decideWorkspaceAllocation,
  requiresGovernedWorkspace,
  workspaceSlug,
  type WorkspaceAllocationDecision,
} from "./workspace-allocation-policy";

/** A task in one of these is finished; a leftover intent must not resurrect it. */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
]);

const RECOVERY_DISPATCH_LEASE_MS = 5 * 60_000;
/**
 * How long a supervisor holds a PREPARED attempt it has picked up.
 *
 * Long enough for a real external worker run, because the claim is what stops a second
 * supervisor executing the same intent; short enough that a supervisor that dies does not
 * strand the attempt for ever — recovery reclaims it once this lapses.
 */
const DISPATCH_CLAIM_LEASE_MS = 30 * 60_000;

export class SupervisorService {
  constructor(
    private readonly missionRepository: MissionRepository,
    private readonly taskRepository: TaskRepository,
    private readonly dispatcher: TaskExecutionDispatcher,
    private readonly durableMemory: DurableMemory,
    private readonly dispatchAttempts?: DispatchAttemptRepository,
    private readonly workspaceExecutionCoordinator?: WorkspaceExecutionCoordinator,
    /**
     * M4 capability routing (decision 0031). Optional: when absent, dispatch
     * behaves exactly as it did before M4 and `tasks.required_capabilities`
     * routes nothing.
     */
    private readonly capabilityRouter?: CapabilityRouter,
    /**
     * Runtime control (decision 0055). When composed, no NEW work is admitted
     * while dispatch is not allowed or the mission is held: ready tasks stay
     * ready and prepared attempts stay PREPARED — held, never failed. Wired at
     * every production composition site.
     */
    private readonly controlGuard?: Pick<RuntimeControlGuard, "dispatch">,
  ) {}

  private async admissionHeld(missionId: string): Promise<boolean> {
    if (!this.controlGuard) return false;
    return !(await this.controlGuard.dispatch(missionId)).allowed;
  }

  /**
   * Resolves the routing decision for one ready MissionTask.
   *
   * requiredCapabilities is read from the DURABLE CANONICAL Task
   * (tasks.required_capabilities, migration 0041) via taskId — not from the
   * MissionTask and not from planner output held in memory. That is the whole
   * point of M4: the value that survived the restart is the value that routes.
   */
  private async routeReadyTask(
    missionTask: { taskId: string; workerKind?: string | null },
  ): Promise<{
    blocked: boolean;
    /** Back-pressure: nothing routable NOW, for reasons that end by themselves. */
    deferred?: boolean;
    workerKind?: string;
    workerId?: string;
    reason?: string;
    routingDecision?: Record<string, unknown>;
  }> {
    if (!this.capabilityRouter) {
      return { blocked: false };
    }

    const canonicalTask = await this.taskRepository.getById(missionTask.taskId);
    const requiredCapabilities = canonicalTask?.requiredCapabilities ?? [];

    /*
     * WHAT must be done, never WHO does it (decision 0054): the planner's canonical Task says
     * how risky and how broad the work is, and the router chooses compute from that. A first
     * dispatch has no prior attempts; a correction is routed by QC, with its history.
     */
    const routing = await this.capabilityRouter.route(
      {
        requiredCapabilities,
        workerKind: missionTask.workerKind ?? undefined,
      },
      {
        role: "writer",
        taskType: requiredCapabilities[0],
        complexity: complexityFromRisk(canonicalTask?.riskClass),
        risk: canonicalTask?.riskClass,
        repositoryMutation: (canonicalTask?.allowedFileScope?.length ?? 0) > 0,
        correctionAttempt: 0,
        priorAttempts: [],
      },
    );

    if (routing.decision === "NO_ELIGIBLE_WORKER" && routing.transient) {
      /*
       * A provider cooldown or a full fleet ends by itself (decision 0054). Blocking here would
       * make one 429 a permanent verdict on every task that became ready during it — nothing
       * ever moves a task out of `blocked`. Still fail closed: nothing is dispatched.
       */
      return { blocked: false, deferred: true, reason: routing.reason };
    }

    if (routing.decision === "NO_ELIGIBLE_WORKER") {
      // FAIL CLOSED: refuse the dispatch rather than hand the task to whatever
      // worker happens to be first. A blocked task is recoverable; work done by
      // an under-qualified worker is not.
      return { blocked: true, reason: routing.reason };
    }

    if (routing.decision === "ROUTED" && routing.worker) {
      /*
       * M5.3: the selected worker's IDENTITY travels with the dispatch, not just
       * its kind. It is what makes durable load countable and what gives the
       * attempt a real producer for attribution and reviewer independence.
       */
      return {
        blocked: false,
        workerKind: routing.worker.workerKind,
        workerId: routing.worker.id,
        routingDecision: routing.evidence,
      };
    }

    // ROUTING_UNCONFIGURED: empty registry, pre-M4 behaviour.
    return { blocked: false };
  }

  /**
   * Explicit restart recovery.
   *
   * Normal run() never rewinds repository state from checkpoints.
   */
  async recover(missionId: string) {
    const checkpointRecovery = await loadMissionCheckpoint(
      {
        missions: this.missionRepository,
        tasks: this.taskRepository,
        durableMemory: this.durableMemory,
      },
      { missionId },
    );

    // N2.3: a persisted dispatch intent is more authoritative than an older
    // checkpoint regarding whether a task was already queued for dispatch.
    if (this.dispatchAttempts) {
      await this.reconcilePreparedDispatches(missionId);
    }

    return checkpointRecovery;
  }

  /**
   * Replays durable dispatch intents that were persisted but whose external
   * dispatch acknowledgement was not durably recorded.
   *
   * Reusing the same deterministic workflowId makes replay safe with Temporal.
   */
  private async requiresWorkspace(taskId: string): Promise<boolean> {
    const task = await this.taskRepository.getById(taskId);
    return requiresGovernedWorkspace({
      taskId,
      title: task?.title ?? taskId,
      riskClass: task?.riskClass,
      allowedFileScope: task?.allowedFileScope,
    });
  }

  async reconcilePreparedDispatches(missionId?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    if (!this.dispatchAttempts) {
      return;
    }

    const prepared = await this.dispatchAttempts.listPrepared(missionId);

    const recoveryOwner = `recovery-${randomUUID()}`;

    const env = loadEnv();
    const digitalosFacadePath = env.DIGITALOS_FACADE_PATH;

    for (const attempt of prepared) {
      signal?.throwIfAborted();

      // Held attempts stay PREPARED; a later reconciliation dispatches them once released.
      if (await this.admissionHeld(attempt.missionId)) {
        continue;
      }

      /*
       * GOVERNED INTENTS ARE NOT REPLAYED HERE (decision 0052). This replay dispatches straight
       * to the dispatcher with no workspace. For a writer that is ungoverned execution: a
       * correction attempt ran with no branch, no gate and no integration, and was then
       * reported done. `run()` claims the same pending intent and governs it.
       */
      if (this.workspaceExecutionCoordinator && (await this.requiresWorkspace(attempt.taskId))) {
        continue;
      }

      const claimed = await this.dispatchAttempts.claimPrepared(
        attempt.id,
        recoveryOwner,
        RECOVERY_DISPATCH_LEASE_MS,
      );

      if (!claimed) {
        continue;
      }

      signal?.throwIfAborted();

      // Re-prepare is intentionally idempotent and also reasserts queued state
      // if a stale checkpoint had moved the MissionTask backwards.
      await this.dispatchAttempts.prepare({
        missionId: attempt.missionId,
        missionTaskId: attempt.missionTaskId,
        taskId: attempt.taskId,
        attempt: attempt.attempt,
        workflowId: attempt.workflowId,
        prompt: attempt.prompt,
        workerKind: attempt.workerKind,
        capability: attempt.capability,
      });

      try {
        signal?.throwIfAborted();

        const result = await this.dispatcher.dispatch({
          missionId: attempt.missionId,
          taskId: attempt.taskId,
          taskTitle: (await this.missionRepository.getMissionTaskById(attempt.missionTaskId))
            ?.title,
          prompt: attempt.prompt,
          workflowId: attempt.workflowId,
          workerKind: attempt.workerKind,
          capability: attempt.capability,
          digitalosFacadePath,
          signal,
        });

        if (result.workflowId !== attempt.workflowId) {
          throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
        }

        signal?.throwIfAborted();

        await this.dispatchAttempts.markDispatched(attempt.id);
      } catch (error) {
        // Leave PREPARED for transport/runtime failures so a later recovery
        // can safely retry the same logical dispatch.
        throw error;
      }
    }
  }

  async run(missionId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();

    const mission = await this.missionRepository.findById(missionId);

    if (!mission) {
      throw new Error("Mission not found");
    }

    let tasks = await this.missionRepository.listTasks(missionId);
    /*
     * READY TASKS, PLUS TASKS THAT ALREADY HAVE A PENDING INTENT.
     *
     * `computeReadyTasks` allows only `draft`, deliberately — a task moves to `queued` the
     * moment its first attempt is prepared, and re-running a queued task would double-dispatch
     * it. But a CORRECTION attempt belongs to a task that is long past draft, so the loop
     * never looked at it again: attempt 2 was prepared in the ledger and no governed path
     * ever picked it up (REPAIR_WORKSPACE_DEFECT). A reviewer's REQUEST_CHANGES therefore
     * ended the work outright.
     *
     * A prepared attempt IS the durable intent to execute, so a task carrying one is work to
     * do whatever its status says. Nothing is double-dispatched: the attempt is claimed under
     * a lease below, and a task with no pending attempt still enters only when ready.
     */
    const preparedByTask = new Map(
      this.dispatchAttempts
        ? (await this.dispatchAttempts.listPrepared(missionId)).map((a) => [a.missionTaskId, a])
        : [],
    );
    // A held mission (or ICOS in safe mode / dispatch disabled) admits nothing new — neither
    // ready draft tasks nor pending intents; the status bookkeeping below still runs.
    const held = await this.admissionHeld(mission.id);
    const ready = held ? [] : computeReadyTasks(mission, tasks);
    const readyIds = new Set(ready.map((t) => t.id));
    const readyTasks = [
      ...ready,
      ...tasks.filter(
        (t) =>
          !held &&
          preparedByTask.has(t.id) &&
          !readyIds.has(t.id) &&
          !TERMINAL_TASK_STATUSES.has(t.status),
      ),
    ];

    const env = loadEnv();
    const digitalosFacadePath = env.DIGITALOS_FACADE_PATH;

    for (const task of readyTasks) {
      signal?.throwIfAborted();

      /*
       * AN EXISTING INTENT IS NOT RE-ROUTED. It already carries the worker it was routed to,
       * and routing again would count that very attempt against its own worker's capacity:
       * a one-slot worker with a pending correction is "fully loaded" by the correction it
       * is waiting to run, so the router answers NO_ELIGIBLE_WORKER and the task blocks for
       * a reason that names nothing actually wrong.
       */
      const pendingAttempt = preparedByTask.get(task.id);
      const routing: Awaited<ReturnType<SupervisorService["routeReadyTask"]>> = pendingAttempt
        ? {
            blocked: false,
            workerKind: pendingAttempt.workerKind,
            workerId: pendingAttempt.workerId,
          }
        : await this.routeReadyTask(task);
      if (routing.blocked) {
        await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "blocked");
        continue;
      }
      if (routing.deferred) continue;
      const routedWorkerKind = routing.workerKind ?? task.workerKind ?? undefined;

      const prompt = task.description || task.title;

      /*
       * GOVERNED WORKSPACE ALLOCATION (M9, defect 23).
       *
       * Decided from the CANONICAL Task — `riskClass` and `allowedFileScope` — not from
       * the routed worker kind. The previous condition here was `routedWorkerKind`, which
       * meant an unrouted task silently skipped governance entirely, and which made WHO
       * executes decide whether the work is governed. What the work may TOUCH decides that.
       */
      /* Only read the canonical Task when a coordinator exists to act on the decision. */
      const canonicalTask = this.workspaceExecutionCoordinator
        ? await this.taskRepository.getById(task.taskId)
        : null;
      const allocation: WorkspaceAllocationDecision = this.workspaceExecutionCoordinator
        ? decideWorkspaceAllocation({
            taskId: task.taskId,
            title: task.title,
            riskClass: canonicalTask?.riskClass,
            allowedFileScope: canonicalTask?.allowedFileScope,
          })
        : { kind: "NOT_REQUIRED", reason: "no workspace coordinator composed" };

      if (this.workspaceExecutionCoordinator && allocation.kind === "REFUSED") {
        /*
         * FAIL CLOSED. A writer we cannot govern must not fall through to the ungoverned
         * path: that path provisions an ad-hoc worktree whose branch nothing ever reviews,
         * integrates or reaps. `blocked` is recoverable and visible; an orphan branch is
         * neither.
         */
        await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "blocked");
        continue;
      }

      if (this.workspaceExecutionCoordinator && allocation.kind === "GOVERNED") {
        let allocated = false;
        /*
         * DEFECT 28 — the gate may not have run yet.
         *
         * When no canonical review exists, the coordinator leaves the work durable and
         * `ready_for_integration` instead of gating it. That is neither success nor
         * failure: the task is still in flight, waiting for the independent reviewer.
         * Marking it terminal here, or releasing its workspace in the `finally`, would
         * destroy the very evidence the reviewer is about to judge.
         */
        let awaitingReview = false;
        /*
         * Set only while this run holds a claim on a pending intent whose workspace is not yet
         * allocated, i.e. nothing can have reached a worker. If allocation fails — typically WORKFLOW_COLLISION while the refused
         * predecessor still holds the task's workspace, awaiting its gate — the claim is given
         * back and the error still fails the wake-up, so the durable outbox retries it. Kept,
         * the claim outlived the failure by its whole lease, the retried wake-up skipped the
         * intent as "claimed", and the correction never ran.
         */
        let releaseUndispatchedClaim: (() => Promise<void>) | null = null;
        try {
          if (!this.dispatchAttempts) {
            throw new Error(
              "MISSING_DISPATCH_ATTEMPT_REPOSITORY: workspace execution requires durable canonical workflow identity",
            );
          }
          /*
           * GOVERN THE ATTEMPT THE LEDGER ALREADY HAS, and only invent one when there is
           * none (REPAIR_WORKSPACE_DEFECT).
           *
           * This used to be `const attemptNumber = 1`, unconditionally. `prepare()` is
           * idempotent on that key, so once attempt 1 existed every later tick simply
           * declined to acquire it and returned — and attempt 2 was therefore NEVER prepared
           * and NEVER allocated a governed workspace. A correction attempt, whether it comes
           * from QC's CORRECT/RETRY or from the self-development repair loop, could not run
           * on the certified path at all. In practice that means a reviewer's REQUEST_CHANGES
           * ended the work: roughly half of real self-development runs died here.
           *
           * The attempt number is not the supervisor's to compute. A pending attempt in the
           * durable ledger IS the intent to execute, so the supervisor picks that one up;
           * absent one, this is a first dispatch and it prepares attempt 1 as before.
           */
          const pending = pendingAttempt;

          let prepared: { attempt: DispatchAttempt; acquired: boolean } | null | undefined;
          if (pending) {
            /*
             * Claiming is what makes this safe under concurrency: exactly one supervisor may
             * hold a non-expired claim, so two ticks cannot both execute the same intent.
             */
            const claimToken = `supervisor-${randomUUID()}`;
            const claimed = await this.dispatchAttempts.claimPrepared(
              pending.id,
              claimToken,
              DISPATCH_CLAIM_LEASE_MS,
            );
            if (!claimed) continue;
            releaseUndispatchedClaim = () =>
              this.dispatchAttempts!.releaseClaim(pending.id, claimToken);
            prepared = { attempt: pending, acquired: true };
          } else {
            const attemptNumber = 1;
            const workflowId = workflowIdForAttempt(task.taskId, attemptNumber);
            prepared = await this.dispatchAttempts
              .prepare({
                missionId: mission.id,
                missionTaskId: task.id,
                taskId: task.taskId,
                attempt: attemptNumber,
                workflowId,
                prompt,
                workerKind: routedWorkerKind,
                workerId: routing.workerId,
                routingDecision: routing.routingDecision,
                capability: task.capability || undefined,
              })
              .catch(rethrowUnlessCapacity);
          }
          // Back-pressure, not failure: the task stays ready for a later tick.
          if (!prepared || !prepared.acquired) continue;

          /*
           * Allocate the governed workspace BEFORE any external execution, keyed by the
           * canonical workflow id. The manager is idempotent on that key, so a retry of
           * the same logical attempt reuses its workspace instead of forking a second one.
           *
           * The worker identity passed here is the ROUTED WORKER'S ID — an execution-unit
           * identity used for attribution and for the gate's self-review refusal. It is
           * not a routing input, and no kind, provider or model reaches this call.
           */
          /* A later attempt supersedes the earlier ones: free their workspaces first. */
          if (prepared.attempt.attempt > 1) {
            await this.workspaceExecutionCoordinator.retireSupersededWorkspaces(
              task.taskId,
              prepared.attempt.workflowId,
            );
          }
          await this.workspaceExecutionCoordinator.allocateWorkspace(
            mission.id,
            task.taskId,
            routing.workerId ?? routedWorkerKind ?? "unassigned",
            /* A later attempt needs its own branch: its predecessor's survives as evidence. */
            prepared.attempt.attempt > 1
              ? workspaceSlug({ taskId: task.taskId, title: task.title }, prepared.attempt.attempt)
              : allocation.slug,
            prepared.attempt.workflowId,
            allocation.fileScope,
          );
          allocated = true;
          /* From here the work may reach a worker: never hand the claim back. */
          releaseUndispatchedClaim = null;

          // Prepare the dispatch input (without workflowId, as the coordinator will handle it)
          const dispatchInput = {
            missionId: mission.id,
            taskId: task.taskId,
            taskTitle: task.title,
            /*
             * The ATTEMPT's prompt, not the task's. A correction attempt carries the review
             * feedback that asked for it; sending the original objective again would throw
             * that away and re-run the work that was already refused.
             */
            prompt: prepared.attempt.prompt,
            workerKind: routedWorkerKind,
            capability: task.capability || undefined,
            digitalosFacadePath,
            signal,
            workflowId: prepared.attempt.workflowId,
          };

          // Execute in workspace (this will dispatch and handle the workspace lifecycle)
          const coordResult = await this.workspaceExecutionCoordinator.executeInWorkspace(
            mission.id,
            task.taskId,
            dispatchInput,
          );
          await this.dispatchAttempts.markDispatched(prepared.attempt.id);

          // Update task status based on coordinator result
          /* Awaiting review OR awaiting integration: in flight, workspace kept (0049). */
          awaitingReview =
            coordResult.awaitingReview === true || coordResult.awaitingIntegration === true;
          if (awaitingReview) {
            // Deliberately no status change: the task stays in flight, pending review.
          } else if (coordResult.success) {
            await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "succeeded");
          } else {
            await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "failed");
          }
        } catch (error) {
          await releaseUndispatchedClaim?.();
          throw error;
        } finally {
          if (allocated && !awaitingReview) {
            // Release workspace
            await this.workspaceExecutionCoordinator.releaseWorkspace(task.taskId);
          }
        }

        continue;
      }

      if (this.dispatchAttempts) {
        const attemptNumber = 1;
        const workflowId = workflowIdForAttempt(task.taskId, attemptNumber);

        // PostgreSQL implementation makes these two state changes atomic:
        //   DispatchAttempt=prepared + MissionTask=queued
        const prepared = await this.dispatchAttempts
          .prepare({
            missionId: mission.id,
            missionTaskId: task.id,
            taskId: task.taskId,
            attempt: attemptNumber,
            workflowId,
            prompt,
            workerKind: routedWorkerKind,
            workerId: routing.workerId,
            routingDecision: routing.routingDecision,
            capability: task.capability || undefined,
          })
          .catch(rethrowUnlessCapacity);

        /*
         * Only the transaction which created the durable intent owns the initial
         * external dispatch side effect. Concurrent Supervisors that observe the
         * same ready task receive acquired=false and must stop.
         *
         * A null result is the M5.3 capacity refusal: the assigned worker filled
         * up between the routing decision and the transaction. Nothing durable
         * changed, the task is still ready, and a later tick will route it —
         * possibly to a different worker. Deliberately NOT `blocked`: blocking
         * would turn transient back-pressure into an operator-visible fault.
         */
        if (!prepared || !prepared.acquired) {
          continue;
        }

        signal?.throwIfAborted();

        const attempt = prepared.attempt;

        try {
          const result = await this.dispatcher.dispatch({
            missionId: mission.id,
            taskId: task.taskId,
            taskTitle: task.title,
            prompt,
            workflowId: attempt.workflowId,
            workerKind: routedWorkerKind,
            capability: task.capability || undefined,
            digitalosFacadePath,
            signal,
          });

          if (result.workflowId !== attempt.workflowId) {
            throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
          }

          signal?.throwIfAborted();

          await this.dispatchAttempts.markDispatched(attempt.id);
        } catch (error) {
          // Important: do NOT convert to failed here.
          // If the process/transport dies after Temporal accepted the workflow
          // but before markDispatched(), PREPARED is exactly what recovery needs
          // in order to replay safely with the same workflowId.
          throw error;
        }

        continue;
      }

      // Legacy compatibility path for existing N1/unit tests which do not yet
      // inject the durable dispatch ledger.
      await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "queued");

      signal?.throwIfAborted();

      await this.dispatcher.dispatch({
        missionId: mission.id,
        taskId: task.taskId,
        taskTitle: task.title,
        prompt,
        workerKind: routedWorkerKind,
        capability: task.capability || undefined,
        digitalosFacadePath,
        signal,
      });
    }

    signal?.throwIfAborted();

    tasks = await this.missionRepository.listTasks(missionId);

    signal?.throwIfAborted();

    if (tasks.some((task) => task.status === "failed")) {
      await this.missionRepository.updateMissionStatus(mission.id, "failed");
      return;
    }

    if (tasks.some((task) => task.status === "blocked")) {
      await this.missionRepository.updateMissionStatus(mission.id, "blocked");
      return;
    }

    if (tasks.some((task) => task.status === "awaiting_approval")) {
      await this.missionRepository.updateMissionStatus(mission.id, "awaiting_approval");
      return;
    }

    if (tasks.every((task) => task.status === "succeeded" || task.status === "superseded")) {
      await this.missionRepository.updateMissionStatus(mission.id, "succeeded");
      return;
    }
  }
}

/**
 * Swallows ONLY the capacity refusal, which is back-pressure rather than an
 * error: the assigned worker filled up between the routing decision (taken
 * outside the transaction) and the atomic guard inside it. Every other failure
 * still propagates — a prepare that fails for any other reason must not be
 * mistaken for a full worker.
 */
function rethrowUnlessCapacity(error: unknown): null {
  if (error instanceof WorkerCapacityExceededError) {
    return null;
  }
  throw error;
}
