import { randomUUID } from "node:crypto";

import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { DurableMemory } from "@/core/context/durable-memory";

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
  ) {}

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

      const prompt = task.description || task.title;

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
          workerKind: task.workerKind || undefined,
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
            workerKind: task.workerKind || undefined,
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
        workerKind: task.workerKind || undefined,
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
    }
  }
}
