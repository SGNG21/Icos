import { randomUUID } from "node:crypto";

import type {
  AuthorizeDispatchStartResult,
  DispatchAttempt,
  DispatchAttemptRepository,
  PrepareDispatchAttemptInput,
  PrepareDispatchAttemptResult,
} from "@/core/contracts/dispatch-attempt";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import { canTransition } from "@/core/tasks/lifecycle";

export class InMemoryDispatchAttemptRepository implements DispatchAttemptRepository {
  private readonly attempts = new Map<string, DispatchAttempt>();

  private prepareQueue: Promise<void> = Promise.resolve();

  private startAuthorizationHookForTest?: () => Promise<void>;

  private readonly recoveryClaims = new Map<
    string,
    {
      token: string;
      until: number;
    }
  >();

  constructor(private readonly missions: MissionRepository, private readonly tasks: TaskRepository) {}

  async prepare(input: PrepareDispatchAttemptInput): Promise<PrepareDispatchAttemptResult> {
    return this.inPrepareCriticalSection(() => this.prepareLocked(input));
  }

  private async prepareLocked(
    input: PrepareDispatchAttemptInput,
  ): Promise<PrepareDispatchAttemptResult> {
    const existing = Array.from(this.attempts.values()).find(
      (attempt) =>
        attempt.missionTaskId === input.missionTaskId && attempt.attempt === input.attempt,
    );
    const workflowOwner = Array.from(this.attempts.values()).find(
      (attempt) => attempt.workflowId === input.workflowId,
    );

    if (workflowOwner && workflowOwner.id !== existing?.id) {
      throw new Error(`DISPATCH_ATTEMPT_CONFLICT: ${input.missionTaskId}/${input.attempt}`);
    }

    if (existing) {
      if (
        existing.missionId !== input.missionId ||
        existing.taskId !== input.taskId ||
        existing.workflowId !== input.workflowId ||
        existing.state !== "prepared"
      ) {
        throw new Error(`DISPATCH_ATTEMPT_CONFLICT: ${input.missionTaskId}/${input.attempt}`);
      }
    }

    const authoritative = Array.from(this.attempts.values())
      .filter((attempt) => attempt.missionTaskId === input.missionTaskId)
      .sort((left, right) => right.attempt - left.attempt)[0];
    if (authoritative && input.attempt < authoritative.attempt) {
      throw new Error(`DISPATCH_ATTEMPT_STALE: ${input.missionTaskId}/${input.attempt}`);
    }

    const [missionTask, canonicalTask] = await Promise.all([
      this.missions.getMissionTaskById(input.missionTaskId),
      this.tasks.getById(input.taskId),
    ]);

    if (
      !missionTask ||
      missionTask.missionId !== input.missionId ||
      missionTask.taskId !== input.taskId
    ) {
      throw new Error("DISPATCH_ATTEMPT_MISSION_TASK_CORRELATION_FAILED");
    }

    if (!canonicalTask) {
      throw new Error(`Task not found: ${input.taskId}`);
    }

    const taskNeedsTransition = canonicalTask.status !== "queued";
    if (
      taskNeedsTransition &&
      !canTransition(canonicalTask.status, "queued") &&
      !(canonicalTask.status === "review_pending" && input.attempt > 1)
    ) {
      throw new Error(
        `Task ${input.taskId} cannot transition from ${canonicalTask.status} to queued`,
      );
    }

    const missionTaskNeedsTransition = missionTask.status !== "queued";
    if (
      missionTaskNeedsTransition &&
      missionTask.status !== "draft" &&
      missionTask.status !== "review_pending"
    ) {
      throw new Error(
        `MissionTask ${input.missionTaskId} cannot transition from ${missionTask.status} to queued`,
      );
    }

    let missionTaskChanged = false;

    try {
      if (missionTaskNeedsTransition) {
        await this.missions.updateMissionTaskStatus(
          input.missionId,
          input.missionTaskId,
          "queued",
        );
        missionTaskChanged = true;
      }

      if (taskNeedsTransition) {
        const transitionResult = await this.tasks.transition(input.taskId, "queued");
        if (!transitionResult.ok) {
          throw new Error(
            `Task ${input.taskId} cannot transition from ${canonicalTask.status} to queued`,
          );
        }
      }
    } catch (error) {
      if (missionTaskChanged) {
        try {
          await this.missions.updateMissionTaskStatus(
            input.missionId,
            input.missionTaskId,
            missionTask.status,
          );
        } catch {
          throw new Error("DISPATCH_PREPARE_ROLLBACK_FAILED");
        }
      }
      throw error;
    }

    if (existing) {
      return {
        attempt: existing,
        acquired: false,
      };
    }

    const now = new Date();

    for (const candidate of this.attempts.values()) {
      if (
        candidate.missionTaskId === input.missionTaskId &&
        candidate.attempt < input.attempt &&
        (candidate.state === "prepared" || candidate.state === "dispatched")
      ) {
        this.recoveryClaims.delete(candidate.id);
        this.attempts.set(candidate.id, {
          ...candidate,
          state: "failed",
          lastError: "DISPATCH_ATTEMPT_SUPERSEDED",
          updatedAt: now,
        });
      }
    }

    const attempt: DispatchAttempt = {
      id: randomUUID(),
      missionId: input.missionId,
      missionTaskId: input.missionTaskId,
      taskId: input.taskId,
      attempt: input.attempt,
      workflowId: input.workflowId,
      prompt: input.prompt,
      workerKind: input.workerKind,
      capability: input.capability,
      state: "prepared",
      createdAt: now,
      updatedAt: now,
    };

    // Persist last: validation and both coordinated state transitions have
    // completed, so a rejected preparation cannot leave a durable intent.
    this.attempts.set(attempt.id, attempt);

    return {
      attempt,
      acquired: true,
    };
  }

  private async inPrepareCriticalSection<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.prepareQueue;
    let release!: () => void;
    this.prepareQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  setStartAuthorizationHookForTest(hook?: () => Promise<void>): void {
    this.startAuthorizationHookForTest = hook;
  }

  async authorizeStart(
    taskId: string,
    workflowId: string,
  ): Promise<AuthorizeDispatchStartResult> {
    const initial = Array.from(this.attempts.values()).find(
      (candidate) => candidate.workflowId === workflowId,
    );
    if (!initial) {
      return {
        ok: false,
        reason: "workflow_not_found",
        message: "workflow d'exécution non corrélé",
      };
    }
    await this.startAuthorizationHookForTest?.();

    return this.inPrepareCriticalSection(async () => {
      const attempt = Array.from(this.attempts.values()).find(
        (candidate) => candidate.workflowId === workflowId,
      );
      if (!attempt) {
        return {
          ok: false,
          reason: "workflow_not_found",
          message: "workflow d'exécution non corrélé",
        };
      }
      if (attempt.taskId !== taskId) {
        return {
          ok: false,
          reason: "workflow_task_mismatch",
          message: "workflow d'exécution non corrélé",
        };
      }
      if (attempt.state !== "prepared" && attempt.state !== "dispatched") {
        return {
          ok: false,
          reason: "attempt_not_eligible",
          message: `dispatch attempt is not eligible to start (state: ${attempt.state})`,
        };
      }
      const authoritative = Array.from(this.attempts.values())
        .filter(
          (candidate) =>
            candidate.missionTaskId === attempt.missionTaskId &&
            (candidate.state === "prepared" || candidate.state === "dispatched"),
        )
        .sort((left, right) => right.attempt - left.attempt)[0];
      if (!authoritative || authoritative.id !== attempt.id) {
        return {
          ok: false,
          reason: "stale_attempt",
          message: "stale dispatch attempt: a newer attempt exists for this task",
        };
      }
      const current = await this.tasks.getById(taskId);
      if (!current) {
        return {
          ok: false,
          reason: "task_not_found",
          message: `tâche inconnue : ${taskId}`,
        };
      }
      if (current.status === "running") {
        return { ok: true, task: current, alreadyRunning: true };
      }
      const transition = await this.tasks.transition(taskId, "running");
      if (!transition.ok) {
        if (transition.reason === "task_not_found") {
          return { ok: false, reason: "task_not_found", message: transition.message };
        }
        if (transition.reason === "audit_failed") {
          return { ok: false, reason: "audit_failed", message: transition.message };
        }
        return {
          ok: false,
          reason: "invalid_transition",
          message: `transition ${current.status} → running interdite`,
        };
      }
      return { ok: true, task: transition.task, alreadyRunning: false };
    });
  }

  async claimPrepared(id: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("RECOVERY_CLAIM_INVALID_LEASE");
    }

    const attempt = this.attempts.get(id);

    if (!attempt || attempt.state !== "prepared") {
      return false;
    }

    const now = Date.now();
    const existing = this.recoveryClaims.get(id);

    if (existing && existing.until > now) {
      return false;
    }

    this.recoveryClaims.set(id, {
      token: ownerToken,
      until: now + leaseMs,
    });

    return true;
  }

  async markDispatched(id: string): Promise<void> {
    this.recoveryClaims.delete(id);

    const attempt = this.attempts.get(id);
    if (attempt?.state === "dispatched") return;
    if (!attempt || attempt.state !== "prepared") {
      throw new Error("DISPATCH_ATTEMPT_INVALID_ACKNOWLEDGEMENT");
    }

    const now = new Date();

    this.attempts.set(id, {
      ...attempt,
      state: "dispatched",
      dispatchedAt: now,
      updatedAt: now,
      lastError: undefined,
    });
  }

  async markFailed(id: string, message: string): Promise<void> {
    this.recoveryClaims.delete(id);

    const attempt = this.attempts.get(id);
    if (!attempt) return;
    const stableMessage = message.startsWith("DISPATCH_") ? message : "DISPATCH_PROVIDER_REJECTED";

    this.attempts.set(id, {
      ...attempt,
      state: "failed",
      updatedAt: new Date(),
      lastError: stableMessage,
    });
  }

  async markCompletedByWorkflowId(workflowId: string): Promise<void> {
    const attempt = Array.from(this.attempts.values()).find(
      (candidate) => candidate.workflowId === workflowId,
    );

    if (attempt?.state === "completed") return;
    if (!attempt || (attempt.state !== "prepared" && attempt.state !== "dispatched")) {
      throw new Error("DISPATCH_ATTEMPT_UNKNOWN_WORKFLOW");
    }

    this.attempts.set(attempt.id, {
      ...attempt,
      state: "completed",
      updatedAt: new Date(),
    });
  }

  async getByWorkflowId(workflowId: string): Promise<DispatchAttempt | null> {
    return (
      Array.from(this.attempts.values()).find((attempt) => attempt.workflowId === workflowId) ?? null
    );
  }

  async listPrepared(missionId?: string): Promise<DispatchAttempt[]> {
    return Array.from(this.attempts.values())
      .filter(
        (attempt) =>
          attempt.state === "prepared" &&
          (missionId === undefined || attempt.missionId === missionId),
      )
      .sort((a, b) => {
        const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });
  }

  /**
   * List all dispatch attempts for a given missionTaskId that are in a non-terminal state.
   * Non-terminal states are "prepared" and "dispatched".
   * Results are sorted by attempt number descending, then by createdAt descending.
   */
  async listNonTerminalByMissionTaskId(missionTaskId: string): Promise<DispatchAttempt[]> {
    return Array.from(this.attempts.values())
      .filter(
        (attempt) =>
          attempt.missionTaskId === missionTaskId &&
          (attempt.state === "prepared" || attempt.state === "dispatched"),
      )
      .sort((a, b) => {
        if (a.attempt !== b.attempt) {
          return b.attempt - a.attempt; // descending attempt
        }
        return b.createdAt.getTime() - a.createdAt.getTime(); // descending createdAt
      });
  }
}