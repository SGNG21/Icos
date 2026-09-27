import { randomUUID } from "node:crypto";

import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { WorkspaceExecutionCoordinator } from "@/server/workspace-manager/workspace-execution-coordinator";

import type { CapabilityRouter } from "@/server/routing/capability-router";

import { computeReadyTasks } from "@/server/supervisor/readiness";
import { loadEnv } from "@/config/env";
import { loadMissionCheckpoint } from "@/server/usecases/load-mission-checkpoint";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";

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
  ): Promise<{ blocked: boolean; workerKind?: string; reason?: string }> {
    if (!this.capabilityRouter) {
      return { blocked: false };
    }

    const canonicalTask = await this.taskRepository.getById(missionTask.taskId);
    const requiredCapabilities = canonicalTask?.requiredCapabilities ?? [];

    const routing = this.capabilityRouter.route({
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
      return { blocked: false, workerKind: routing.worker.workerKind };
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

      // Phase 8D: Use WorkspaceExecutionCoordinator for workspace-aware execution
      if (this.workspaceExecutionCoordinator && routedWorkerKind) {
        let allocated = false;
        try {
          if (!this.dispatchAttempts) {
            throw new Error(
              "MISSING_DISPATCH_ATTEMPT_REPOSITORY: workspace execution requires durable canonical workflow identity",
            );
          }
          const attemptNumber = 1;
          const workflowId = workflowIdForAttempt(task.taskId, attemptNumber);
          const prepared = await this.dispatchAttempts.prepare({
            missionId: mission.id,
            missionTaskId: task.id,
            taskId: task.taskId,
            attempt: attemptNumber,
            workflowId,
            prompt,
            workerKind: routedWorkerKind,
            capability: task.capability || undefined,
          });
          if (!prepared.acquired) continue;

          // Allocate workspace for this task
          await this.workspaceExecutionCoordinator.allocateWorkspace(
            mission.id,
            task.taskId,
            routedWorkerKind,
            task.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .slice(0, 30),
            prepared.attempt.workflowId,
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
        const prepared = await this.dispatchAttempts.prepare({
          missionId: mission.id,
          missionTaskId: task.id,
          taskId: task.taskId,
          attempt: attemptNumber,
          workflowId,
          prompt,
          workerKind: routedWorkerKind,
          capability: task.capability || undefined,
        });

        // Only the transaction which created the durable intent owns the
        // initial external dispatch side effect. Concurrent Supervisors that
        // observe the same ready task receive acquired=false and must stop.
        if (!prepared.acquired) {
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
