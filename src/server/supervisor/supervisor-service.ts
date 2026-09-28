import { randomUUID } from "node:crypto";

import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import {
  WorkerCapacityExceededError,
  type DispatchAttemptRepository,
} from "@/core/contracts/dispatch-attempt";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { WorkspaceExecutionCoordinator } from "@/server/workspace-manager/workspace-execution-coordinator";

import type { CapabilityRouter } from "@/server/routing/capability-router";

import { computeReadyTasks } from "@/server/supervisor/readiness";
import { loadEnv } from "@/config/env";
import { loadMissionCheckpoint } from "@/server/usecases/load-mission-checkpoint";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import {
  decideWorkspaceAllocation,
  type WorkspaceAllocationDecision,
} from "./workspace-allocation-policy";

const RECOVERY_DISPATCH_LEASE_MS = 5 * 60_000;

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
  ) {}

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
  ): Promise<{ blocked: boolean; workerKind?: string; workerId?: string; reason?: string }> {
    if (!this.capabilityRouter) {
      return { blocked: false };
    }

    const canonicalTask = await this.taskRepository.getById(missionTask.taskId);
    const requiredCapabilities = canonicalTask?.requiredCapabilities ?? [];

    const routing = await this.capabilityRouter.route({
      requiredCapabilities,
      workerKind: missionTask.workerKind ?? undefined,
    });

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
    const readyTasks = computeReadyTasks(mission, tasks);

    const env = loadEnv();
    const digitalosFacadePath = env.DIGITALOS_FACADE_PATH;

    for (const task of readyTasks) {
      signal?.throwIfAborted();

      const routing = await this.routeReadyTask(task);
      if (routing.blocked) {
        await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "blocked");
        continue;
      }
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
        try {
          if (!this.dispatchAttempts) {
            throw new Error(
              "MISSING_DISPATCH_ATTEMPT_REPOSITORY: workspace execution requires durable canonical workflow identity",
            );
          }
          const attemptNumber = 1;
          const workflowId = workflowIdForAttempt(task.taskId, attemptNumber);
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
              capability: task.capability || undefined,
            })
            .catch(rethrowUnlessCapacity);
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
          await this.workspaceExecutionCoordinator.allocateWorkspace(
            mission.id,
            task.taskId,
            routing.workerId ?? routedWorkerKind ?? "unassigned",
            allocation.slug,
            prepared.attempt.workflowId,
            allocation.fileScope,
          );
          allocated = true;

          // Prepare the dispatch input (without workflowId, as the coordinator will handle it)
          const dispatchInput = {
            missionId: mission.id,
            taskId: task.taskId,
            taskTitle: task.title,
            prompt,
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
          if (coordResult.success) {
            await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "succeeded");
          } else {
            await this.missionRepository.updateMissionTaskStatus(mission.id, task.id, "failed");
          }
        } finally {
          if (allocated) {
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
