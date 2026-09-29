import { randomUUID } from "node:crypto";

import {
  WorkerCapacityExceededError,
  type AuthorizeDispatchStartResult,
  type DispatchAttempt,
  type DispatchAttemptRepository,
  type PrepareDispatchAttemptInput,
  type PrepareDispatchAttemptResult,
  type RecordExecutionFailureInput,
  type ResumableAttemptState,
} from "@/core/contracts/dispatch-attempt";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import { canTransition } from "@/core/tasks/lifecycle";

export class InMemoryDispatchAttemptRepository implements DispatchAttemptRepository {
  private readonly attempts = new Map<string, DispatchAttempt>();

  /*
   * Execution leases, kept SEPARATE from `recoveryClaims` for the same reason the
   * Postgres table uses separate columns (migration 0046): one fences who may
   * dispatch a prepared attempt, the other fences who is running a dispatched one,
   * and both can be held at once by different processes.
   */
  private readonly executionLeases = new Map<string, { owner: string; until: number }>();

  private prepareQueue: Promise<void> = Promise.resolve();

  private startAuthorizationHookForTest?: () => Promise<void>;

  private readonly recoveryClaims = new Map<
    string,
    {
      token: string;
      until: number;
    }
  >();

  constructor(
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    /**
     * Optional registry, so capacity can be enforced against the worker's
     * DECLARED maximum rather than a hardcoded one (M5.3/M5.5). Absent means no
     * capacity enforcement here: the durable repository is the authority, and
     * inventing a limit this one cannot read would be worse than admitting it
     * does not know.
     */
    private readonly workerRegistry?: WorkerRegistryStore,
  ) {}

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
        existing.workflowId !== input.workflowId
      ) {
        throw new Error(`DISPATCH_ATTEMPT_CONFLICT: ${input.missionTaskId}/${input.attempt}`);
      }
      // Same logical dispatch already progressed by a concurrent supervisor:
      // converge idempotently, own nothing, and leave task state untouched.
      if (existing.state === "dispatched" || existing.state === "completed") {
        return { attempt: existing, acquired: false };
      }
      if (existing.state !== "prepared") {
        throw new Error(`DISPATCH_ATTEMPT_CONFLICT: ${input.missionTaskId}/${input.attempt}`);
      }
    }

    /*
     * Capacity parity with PostgreSQL (M5.3). prepareLocked already runs in a
     * serialised critical section, which is this implementation's equivalent of
     * the row lock the durable repository takes.
     */
    if (input.workerId) {
      await this.assertWorkerCapacity(input.workerId, input.missionTaskId);
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
      workerId: input.workerId,
      capability: input.capability,
      routingDecision: input.routingDecision,
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

  /** Worker ids on non-terminal attempts: one entry per active execution. */
  async listActiveWorkerAssignments(): Promise<string[]> {
    return Array.from(this.attempts.values())
      .filter(
        (attempt) =>
          attempt.workerId !== undefined &&
          (attempt.state === "prepared" || attempt.state === "dispatched"),
      )
      .map((attempt) => attempt.workerId as string)
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Capacity enforcement parity, for the single-process in-memory root.
   *
   * Enforces the worker's DECLARED maximum and its capacity pool, read from the
   * injected registry. With no registry nothing is enforced here — see the
   * constructor.
   */
  private async assertWorkerCapacity(workerId: string, missionTaskId: string): Promise<void> {
    if (!this.workerRegistry) {
      return;
    }

    const worker = await this.workerRegistry.get(workerId);
    if (!worker) {
      throw new WorkerCapacityExceededError(workerId, "is not registered");
    }

    const active = Array.from(this.attempts.values()).filter(
      (attempt) => attempt.state === "prepared" || attempt.state === "dispatched",
    );
    // A retry of the same logical work must not be blocked by its own predecessor.
    const own = active.filter((attempt) => attempt.missionTaskId === missionTaskId).length;
    const discount = (count: number) => count - Math.min(count, own);

    const mine = active.filter((attempt) => attempt.workerId === workerId).length;
    if (discount(mine) >= worker.maxConcurrency) {
      throw new WorkerCapacityExceededError(
        workerId,
        `already holds ${mine} of ${worker.maxConcurrency} concurrent executions`,
      );
    }

    if (!worker.capacityPool) {
      return;
    }

    const pool = (await this.workerRegistry.list()).filter(
      (candidate) => candidate.capacityPool === worker.capacityPool,
    );
    const declared = pool
      .map((member) => member.capacityPoolLimit)
      .filter((limit): limit is number => limit !== null);

    if (declared.length === 0) {
      return;
    }

    // A quota is a ceiling: when members disagree, the SMALLEST wins.
    const limit = Math.min(...declared);
    const memberIds = new Set(pool.map((member) => member.id));
    const poolActive = active.filter(
      (attempt) => attempt.workerId !== undefined && memberIds.has(attempt.workerId),
    ).length;

    if (discount(poolActive) >= limit) {
      throw new WorkerCapacityExceededError(
        workerId,
        `capacity pool ${worker.capacityPool} holds ${poolActive} of ${limit}`,
      );
    }
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

  async releaseClaim(id: string, ownerToken: string): Promise<void> {
    if (this.recoveryClaims.get(id)?.token === ownerToken) this.recoveryClaims.delete(id);
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

  async recordExecutionFailure(id: string, input: RecordExecutionFailureInput): Promise<void> {
    /* Terminal: holding a fence would only block the recovery that should happen. */
    this.executionLeases.delete(id);
    this.recoveryClaims.delete(id);

    const attempt = this.attempts.get(id);
    if (!attempt) return;

    this.attempts.set(id, {
      ...attempt,
      state: "failed",
      updatedAt: new Date(),
      lastError: input.message.slice(0, 2_000),
      failureClass: input.failureClass,
      resumeToken: input.resumeToken,
      handoff: input.handoff,
      executionDurationMs: input.durationMs,
    });
  }

  async acquireExecutionLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("EXECUTION_LEASE_INVALID_LEASE");
    }

    const attempt = this.attempts.get(id);
    /* Only a live execution may be leased; a terminal attempt is done. */
    if (!attempt || (attempt.state !== "prepared" && attempt.state !== "dispatched")) {
      return false;
    }

    const now = Date.now();
    const existing = this.executionLeases.get(id);
    /* Free, expired, or already ours. Anything else belongs to someone running. */
    if (existing && existing.until >= now && existing.owner !== owner) {
      return false;
    }

    this.executionLeases.set(id, { owner, until: now + leaseMs });
    return true;
  }

  async holdsExecutionLease(id: string, owner: string): Promise<boolean> {
    const lease = this.executionLeases.get(id);
    /* An expired lease is NOT held: time alone revokes it. */
    return Boolean(lease && lease.owner === owner && lease.until >= Date.now());
  }

  /** Test seam: expire a lease without waiting for the clock. */
  expireExecutionLeaseForTest(id: string): void {
    const lease = this.executionLeases.get(id);
    if (lease) this.executionLeases.set(id, { ...lease, until: Date.now() - 1 });
  }

  async latestResumableState(missionTaskId: string): Promise<ResumableAttemptState | null> {
    const candidates = Array.from(this.attempts.values())
      .filter((a) => a.missionTaskId === missionTaskId && a.resumeToken !== undefined)
      /* Newest attempt wins: resume continues the most recent work, not the first. */
      .sort((a, b) => b.attempt - a.attempt);

    const latest = candidates[0];
    if (!latest) return null;

    return {
      attempt: latest.attempt,
      resumeToken: latest.resumeToken,
      handoff: latest.handoff,
      failureClass: latest.failureClass,
    };
  }

  async markCompletedByWorkflowId(workflowId: string, durationMs?: number): Promise<void> {
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
      ...(durationMs === undefined ? {} : { executionDurationMs: durationMs }),
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