import {
  completionForSettlement,
  type IntegrationSettlementPort,
  type QualityAction,
  type QualityControlJob,
  type QualityControlRepository,
  type RegisterQualityControlInput,
  type RegisterQualityControlResult,
} from "@/core/contracts/quality-control";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { AutonomousMissionRuntimeRepository } from "@/server/autonomy/runtime";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository, TaskRepository } from "@/server/repositories/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";

/** MissionTask statuses of work still in flight: the only ones a settlement may change. */
const IN_FLIGHT: ReadonlySet<string> = new Set(["queued", "running", "review_pending"]);

function clone(job: QualityControlJob): QualityControlJob {
  return structuredClone(job);
}

export class InMemoryQualityControlRepository implements QualityControlRepository {
  private readonly jobs = new Map<string, QualityControlJob>();

  private actionQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly missions: MissionRepository,
    private readonly tasks: TaskRepository,
    private readonly executionResults: TaskExecutionResultRepository,
    private readonly reviewDecisions: ReviewDecisionRepository,
    private readonly dispatchAttempts: DispatchAttemptRepository,
    private readonly autonomousRuntime?: AutonomousMissionRuntimeRepository,
    /** Governed integration state (DEFECT 36); same semantics as the PostgreSQL repository. */
    private readonly settlement?: IntegrationSettlementPort,
  ) {}

  async register(input: RegisterQualityControlInput): Promise<RegisterQualityControlResult> {
    const existing = this.jobs.get(input.workflowId);
    if (existing) {
      this.assertSameIdentity(existing, input);
      return { job: clone(existing), acquired: false };
    }

    const result = await this.executionResults.getByWorkflowId(input.workflowId);
    const attempt = await this.dispatchAttempts.getByWorkflowId(input.workflowId);
    const missionTask = await this.missions.getMissionTaskById(input.missionTaskId);
    if (
      !result ||
      !attempt ||
      !missionTask ||
      result.id !== input.executionResultId ||
      result.taskId !== input.taskId ||
      attempt.missionId !== input.missionId ||
      attempt.missionTaskId !== input.missionTaskId ||
      attempt.taskId !== input.taskId ||
      attempt.attempt !== input.executionAttempt ||
      missionTask.missionId !== input.missionId ||
      missionTask.taskId !== input.taskId
    ) {
      throw new Error("QUALITY_CONTROL_EXECUTION_CORRELATION_FAILED");
    }

    const now = new Date();
    const job: QualityControlJob = {
      ...input,
      reviewAttemptCount: 0,
      state: "review_pending",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.workflowId, job);
    /* In flight only: registering a result never revives a cancelled or settled task. */
    if (IN_FLIGHT.has(missionTask.status)) {
      await this.missions.updateMissionTaskStatus(
        input.missionId,
        input.missionTaskId,
        "review_pending",
      );
    }
    return { job: clone(job), acquired: true };
  }

  async claimNext(
    missionId: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<QualityControlJob | null> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("QUALITY_CONTROL_INVALID_LEASE");
    }

    const now = Date.now();
    const job = [...this.jobs.values()]
      .filter(
        (candidate) =>
          candidate.missionId === missionId &&
          (candidate.state === "review_pending" ||
            candidate.state === "reviewing" ||
            candidate.state === "review_unavailable" ||
            candidate.state === "decision_ready") &&
          (!candidate.claimUntil || candidate.claimUntil.getTime() <= now),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.workflowId.localeCompare(right.workflowId),
      )[0];

    if (!job) return null;

    const claimed: QualityControlJob = {
      ...job,
      state:
        job.state === "review_pending" || job.state === "review_unavailable"
          ? "reviewing"
          : job.state,
      // A recovered unavailable review gets a fresh review budget.
      reviewAttemptCount:
        job.state === "review_unavailable"
          ? 1
          : job.state === "review_pending" || job.state === "reviewing"
            ? job.reviewAttemptCount + 1
            : job.reviewAttemptCount,
      claimToken: ownerToken,
      claimUntil: new Date(now + leaseMs),
      updatedAt: new Date(now),
    };
    this.jobs.set(job.workflowId, claimed);
    return clone(claimed);
  }

  async saveDecision(
    workflowId: string,
    ownerToken: string,
    input: {
      review: import("@/core/contracts/review").ReviewDecisionRecord;
      action: QualityAction;
    },
  ): Promise<QualityControlJob> {
    const job = this.requireOwned(workflowId, ownerToken);
    if (job.state === "decision_ready") {
      if (job.reviewDecisionId !== input.review.id || job.action !== input.action) {
        throw new Error("QUALITY_CONTROL_DECISION_CONFLICT");
      }
      return clone(job);
    }
    if (job.state !== "reviewing") {
      throw new Error("QUALITY_CONTROL_INVALID_DECISION_STATE");
    }

    const review = await this.reviewDecisions.save(input.review);
    if (review.workflowId !== workflowId || review.taskId !== job.taskId) {
      throw new Error("QUALITY_CONTROL_REVIEW_CORRELATION_FAILED");
    }

    const updated: QualityControlJob = {
      ...job,
      state: "decision_ready",
      reviewDecisionId: review.id,
      action: input.action,
      updatedAt: new Date(),
    };
    this.jobs.set(workflowId, updated);
    return clone(updated);
  }

  async applyAction(
    workflowId: string,
    ownerToken: string,
    input: {
      nextAttempt?: number;
      nextWorkflowId?: string;
      prompt?: string;
      /** The worker the retry is ROUTED to (M7.1). */
      workerId?: string;
      routingDecision?: Record<string, unknown>;
      replanReason?: string;
      forceEscalate?: boolean;
    },
  ): Promise<{ job: QualityControlJob; dispatchAcquired: boolean }> {
    return this.inActionCriticalSection(async () => {
      const wasDecisionReady = this.jobs.get(workflowId)?.state === "decision_ready";
      const result = await this.applyActionLocked(workflowId, ownerToken, input);
      if (!wasDecisionReady) return result;
      // Outbox flag set in the same critical section as the state change.
      const flagged = { ...this.jobs.get(workflowId)!, wakeupPending: true };
      this.jobs.set(workflowId, flagged);
      return { ...result, job: clone(flagged) };
    });
  }

  private async applyActionLocked(
    workflowId: string,
    ownerToken: string,
    input: {
      nextAttempt?: number;
      nextWorkflowId?: string;
      prompt?: string;
      /** The worker the retry is ROUTED to (M7.1). */
      workerId?: string;
      routingDecision?: Record<string, unknown>;
      replanReason?: string;
      forceEscalate?: boolean;
    },
  ): Promise<{ job: QualityControlJob; dispatchAcquired: boolean }> {
    const job = this.requireOwned(workflowId, ownerToken);
    if (job.state === "action_applied" || job.state === "escalated") {
      return { job: clone(job), dispatchAcquired: false };
    }
    if (job.state !== "decision_ready" || !job.action) {
      throw new Error("QUALITY_CONTROL_ACTION_NOT_READY");
    }

    const review = job.reviewDecisionId
      ? await this.reviewDecisions.getById(job.reviewDecisionId)
      : null;
    if (!review) throw new Error("QUALITY_CONTROL_REVIEW_NOT_FOUND");

    if (input.forceEscalate) {
      await this.missions.updateMissionTaskStatus(job.missionId, job.missionTaskId, "failed");
      await this.tasks.transition(job.taskId, "failed");
      const escalated: QualityControlJob = {
        ...job,
        state: "escalated",
        action: "ESCALATE",
        claimToken: undefined,
        claimUntil: undefined,
        lastError: input.replanReason ?? "QUALITY_CONTROL_BUDGET_EXHAUSTED",
        updatedAt: new Date(),
      };
      this.jobs.set(workflowId, escalated);
      return { job: clone(escalated), dispatchAcquired: false };
    }

    let dispatchAcquired = false;
    switch (job.action) {
      case "ACCEPT": {
        /* DEFECT 36: governed work completes on its integration, not on its review. */
        const status = this.settlement
          ? completionForSettlement(await this.settlement.settlementOf(workflowId))
          : "succeeded";
        if (!status) break;
        await this.missions.updateMissionTaskStatus(job.missionId, job.missionTaskId, status);
        await this.tasks.transition(job.taskId, status);
        break;
      }
      case "ESCALATE":
        await this.missions.updateMissionTaskStatus(job.missionId, job.missionTaskId, "failed");
        await this.tasks.transition(job.taskId, "failed");
        break;
      case "CORRECT":
      case "RETRY": {
        if (!input.nextAttempt || !input.nextWorkflowId || !input.prompt) {
          throw new Error("QUALITY_CONTROL_ATTEMPT_INPUT_MISSING");
        }
        const missionTask = await this.missions.getMissionTaskById(job.missionTaskId);
        const prepared = await this.dispatchAttempts.prepare({
          missionId: job.missionId,
          missionTaskId: job.missionTaskId,
          taskId: job.taskId,
          attempt: input.nextAttempt,
          workflowId: input.nextWorkflowId,
          prompt: input.prompt,
          workerKind: missionTask?.workerKind ?? undefined,
          /*
           * M7.1 — the routed worker travels with the retry. `prepare()` enforces that
           * worker's capacity inside its own transaction, so the in-memory path gets the
           * same guarantee as PostgreSQL for free.
           */
          workerId: input.workerId,
          routingDecision: input.routingDecision,
          capability: missionTask?.capability ?? undefined,
        });
        dispatchAcquired = prepared.acquired;
        break;
      }
      case "REPLAN": {
        if (!input.replanReason || !this.autonomousRuntime) {
          throw new Error("QUALITY_CONTROL_REPLAN_RUNTIME_UNAVAILABLE");
        }
        const runtime = await this.autonomousRuntime.get(job.missionId);
        if (!runtime) throw new Error("QUALITY_CONTROL_REPLAN_RUNTIME_NOT_FOUND");
        if (runtime.replanCount >= runtime.maxReplans) {
          await this.missions.updateMissionTaskStatus(job.missionId, job.missionTaskId, "failed");
          await this.tasks.transition(job.taskId, "failed");
          const escalated: QualityControlJob = {
            ...job,
            state: "escalated",
            action: "ESCALATE",
            lastError: "QUALITY_CONTROL_REPLAN_BUDGET_EXHAUSTED",
            claimToken: undefined,
            claimUntil: undefined,
            updatedAt: new Date(),
          };
          this.jobs.set(workflowId, escalated);
          return { job: clone(escalated), dispatchAcquired: false };
        }
        const now = new Date();
        // Phase 6: the reviewed task belongs to the obsolete graph that REPLAN
        // discards. Supersede it durably before entering replanning so the
        // subsequent atomic replacePlan() does not reject it as active work.
        // Idempotent: replacePlan re-supersedes any non-succeeded task.
        await this.missions.updateMissionTaskStatus(job.missionId, job.missionTaskId, "superseded");
        await this.autonomousRuntime.save({
          ...runtime,
          state: "replanning",
          lastReason: input.replanReason,
          updatedAt: now,
          lastHeartbeatAt: now,
        });
        break;
      }
    }

    const updated: QualityControlJob = {
      ...job,
      state: job.action === "ESCALATE" ? "escalated" : "action_applied",
      claimToken: undefined,
      claimUntil: undefined,
      updatedAt: new Date(),
    };
    this.jobs.set(workflowId, updated);
    return { job: clone(updated), dispatchAcquired };
  }

  private async inActionCriticalSection<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.actionQueue;
    let release!: () => void;
    this.actionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async releaseForRetry(workflowId: string, ownerToken: string, errorCode: string): Promise<void> {
    const job = this.requireOwned(workflowId, ownerToken);
    this.jobs.set(workflowId, {
      ...job,
      state: job.reviewDecisionId ? "decision_ready" : "review_pending",
      claimToken: undefined,
      claimUntil: undefined,
      lastError: errorCode,
      updatedAt: new Date(),
    });
  }

  async escalateOwned(workflowId: string, ownerToken: string, reason: string): Promise<void> {
    const job = this.requireOwned(workflowId, ownerToken);
    await this.missions.updateMissionTaskStatus(job.missionId, job.missionTaskId, "failed");
    await this.tasks.transition(job.taskId, "failed");
    this.jobs.set(workflowId, {
      ...job,
      state: "escalated",
      action: "ESCALATE",
      claimToken: undefined,
      claimUntil: undefined,
      lastError: reason,
      wakeupPending: true,
      updatedAt: new Date(),
    });
  }

  async markReviewUnavailable(
    workflowId: string,
    ownerToken: string,
    reason: string,
    cooldownMs: number,
  ): Promise<void> {
    const job = this.requireOwned(workflowId, ownerToken);
    this.jobs.set(workflowId, {
      ...job,
      state: "review_unavailable",
      claimToken: undefined,
      claimUntil: new Date(Date.now() + cooldownMs),
      lastError: reason,
      updatedAt: new Date(),
    });
  }

  async listWakeupMissionIds(limit = 100): Promise<string[]> {
    return [
      ...new Set(
        [...this.jobs.values()].filter((job) => job.wakeupPending).map((job) => job.missionId),
      ),
    ].slice(0, limit);
  }

  async listPendingWakeups(missionId: string): Promise<string[]> {
    return [...this.jobs.values()]
      .filter((job) => job.missionId === missionId && job.wakeupPending)
      .map((job) => job.workflowId);
  }

  async completeWakeups(workflowIds: string[]): Promise<void> {
    for (const id of workflowIds) {
      const job = this.jobs.get(id);
      if (job) this.jobs.set(id, { ...job, wakeupPending: false });
    }
  }

  async recoverUnregistered(missionId?: string): Promise<number> {
    let recovered = 0;
    const taskIds = (await this.tasks.list()).map((task) => task.id);
    const results = await this.executionResults.listByTaskIds(taskIds);
    for (const result of results) {
      if (this.jobs.has(result.workflowId)) continue;
      const attempt = await this.dispatchAttempts.getByWorkflowId(result.workflowId);
      if (!attempt || (missionId !== undefined && attempt.missionId !== missionId)) continue;
      await this.register({
        workflowId: result.workflowId,
        executionResultId: result.id,
        missionId: attempt.missionId,
        missionTaskId: attempt.missionTaskId,
        taskId: attempt.taskId,
        executionAttempt: attempt.attempt,
      });
      recovered += 1;
    }
    return recovered;
  }

  async listRecoverableMissionIds(limit = 100): Promise<string[]> {
    const unsettled = (await this.unsettledAccepted()).map((job) => job.missionId);
    return [
      ...new Set([...(await this.listPending()).map((job) => job.missionId), ...unsettled]),
    ].slice(0, limit);
  }

  async settleAccepted(missionId?: string): Promise<number> {
    if (!this.settlement) return 0;
    return this.inActionCriticalSection(async () => {
      let settled = 0;
      for (const job of await this.unsettledAccepted(missionId)) {
        const status = completionForSettlement(await this.settlement!.settlementOf(job.workflowId));
        const current = await this.missions.getMissionTaskById(job.missionTaskId);
        if (!status || !current || !IN_FLIGHT.has(current.status)) continue;
        await this.missions.updateMissionTaskStatus(job.missionId, job.missionTaskId, status);
        await this.tasks.transition(job.taskId, status);
        this.jobs.set(job.workflowId, { ...job, wakeupPending: true, updatedAt: new Date() });
        settled += 1;
      }
      return settled;
    });
  }

  private async unsettledAccepted(missionId?: string): Promise<QualityControlJob[]> {
    const out: QualityControlJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.action !== "ACCEPT" || job.state !== "action_applied") continue;
      if (missionId !== undefined && job.missionId !== missionId) continue;
      const task = await this.missions.getMissionTaskById(job.missionTaskId);
      if (task && IN_FLIGHT.has(task.status)) out.push(job);
    }
    return out;
  }

  async getByWorkflowId(workflowId: string): Promise<QualityControlJob | null> {
    const job = this.jobs.get(workflowId);
    return job ? clone(job) : null;
  }

  async listEscalated(missionId?: string): Promise<QualityControlJob[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          (missionId === undefined || job.missionId === missionId) && job.state === "escalated",
      )
      .map(clone);
  }

  async listPending(missionId?: string): Promise<QualityControlJob[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          (missionId === undefined || job.missionId === missionId) &&
          job.state !== "action_applied" &&
          job.state !== "escalated",
      )
      .map(clone);
  }

  private requireOwned(workflowId: string, ownerToken: string): QualityControlJob {
    const job = this.jobs.get(workflowId);
    if (
      !job ||
      job.claimToken !== ownerToken ||
      !job.claimUntil ||
      job.claimUntil.getTime() <= Date.now()
    ) {
      throw new Error("QUALITY_CONTROL_OWNERSHIP_LOST");
    }
    return job;
  }

  private assertSameIdentity(
    existing: QualityControlJob,
    input: RegisterQualityControlInput,
  ): void {
    if (
      existing.executionResultId !== input.executionResultId ||
      existing.missionId !== input.missionId ||
      existing.missionTaskId !== input.missionTaskId ||
      existing.taskId !== input.taskId ||
      existing.executionAttempt !== input.executionAttempt
    ) {
      throw new Error("QUALITY_CONTROL_EXECUTION_CONFLICT");
    }
  }
}
