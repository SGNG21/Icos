import { randomUUID } from "node:crypto";

import type {
  DispatchPreparedQualityAttempt,
  QualityAction,
  QualityControlRepository,
} from "@/core/contracts/quality-control";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository, TaskRepository } from "@/server/repositories/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import type { ReviewerCompute, ReviewerService } from "@/server/review/ports";

/** The capability a candidate declares to be routable as an independent reviewer (0054). */
export const REVIEW_CAPABILITY = "review";
import { firstLineRedacted } from "@/server/workers/probes/probe-redaction";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { reviewDecisionRecordSchema } from "@/core/contracts/review";
import type { CapabilityRouter } from "@/server/routing/capability-router";
import { complexityFromRisk, type PriorAttemptFact } from "@/core/workers/compute-routing";

const QUALITY_CONTROL_LEASE_MS = 5 * 60_000;
/** Cool-down before a review parked as unavailable is retried with a fresh budget. */
export const REVIEW_UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;
export const MAX_REVIEW_ATTEMPTS = 3;
export const MAX_CORRECTION_ATTEMPTS = 2;
export const MAX_EXECUTION_RETRIES = 2;

export interface QualityControlServiceDeps {
  missions: MissionRepository;
  tasks: TaskRepository;
  executionResults: TaskExecutionResultRepository;
  reviewer: ReviewerService;
  reviewDecisions: ReviewDecisionRepository;
  dispatchAttempts: DispatchAttemptRepository;
  qualityJobs: QualityControlRepository;
  assertOwned?: (missionId: string, signal?: AbortSignal) => Promise<void>;
  dispatchPrepared?: DispatchPreparedQualityAttempt;
  reviewUnavailableCooldownMs?: number;
  /**
   * THE canonical routing authority (M7.1). Optional: a deployment with no registry
   * routes nothing and keeps its pre-M4 behaviour.
   *
   * Without it, a CORRECT/RETRY attempt was created with `worker_id = NULL` — unrouted,
   * and therefore unexecutable by any dispatcher that resolves its worker from the
   * ledger. The external worker executor (0038) fails such an attempt closed with
   * PROVIDER_UNAVAILABLE, so the retry burned a budget slot and changed nothing. This is
   * the same `CapabilityRouter` the supervisor uses; QC is a second CALLER of one
   * authority, never a second authority.
   */
  capabilityRouter?: CapabilityRouter;
}

export interface RegisterExecutionInput {
  missionId: string;
  missionTaskId: string;
  taskId: string;
  workflowId: string;
}

function actionForDecision(decision: string): QualityAction {
  switch (decision) {
    case "APPROVE":
      return "ACCEPT";
    case "REQUEST_CHANGES":
      return "CORRECT";
    case "RETRY":
      return "RETRY";
    case "REPLAN":
      return "REPLAN";
    case "BLOCK":
    case "ESCALATE_TO_HUMAN":
      return "ESCALATE";
    default:
      throw new Error("QUALITY_CONTROL_UNKNOWN_REVIEW_DECISION");
  }
}

/**
 * Raised when a retry is due but the fleet can take nothing right now (M7.1).
 *
 * Deliberately NOT a decision. Creating an unroutable attempt would consume a retry
 * from a bounded budget to record a FLEET problem as a TASK failure. Throwing releases
 * the job for a later sweep instead — back-pressure, matching the dispatch rule that a
 * task with no eligible worker stays recoverable rather than failing.
 */
export const QUALITY_CONTROL_NO_ELIGIBLE_WORKER = "QUALITY_CONTROL_NO_ELIGIBLE_WORKER";

/**
 * The STAGE a review attempt died in. Without it a failure is just "the review failed",
 * which is what `stableReviewError` has always persisted and why two missions sat parked
 * for hours with nothing in the logs to act on.
 */
export type ReviewFailureStage =
  | "route_reviewer"
  | "load_context"
  | "reviewer_invocation"
  | "response_validation"
  | "save_decision"
  | "apply_action"
  | "unknown";

/**
 * Everything knowable about ONE failed review attempt, in one structured line.
 *
 * `stableReviewError` deliberately returns a STABLE code because the state machine
 * branches on it — but it collapses every unrecognised error to
 * QUALITY_CONTROL_REVIEW_FAILED, discarding class, message and stack. That is the whole
 * of the silence: the cause existed, was caught, and was thrown away one line later.
 *
 * So the stable code stays, and the detail is emitted beside it. Redacted with the same
 * helper the worker probes use, because a provider error can quote a request.
 */
export function reviewFailureDiagnostic(input: {
  workflowId: string;
  missionId: string;
  taskId: string;
  attemptNumber: number;
  stage: ReviewFailureStage;
  startedAtMs: number;
  routedWorkerId?: string;
  provider?: string;
  model?: string;
  attributionKey?: string;
  error: unknown;
}): Record<string, unknown> {
  const error = input.error;
  return {
    event: "REVIEW_ATTEMPT_FAILED",
    reviewAttemptId: `${input.workflowId}#${input.attemptNumber}`,
    missionId: input.missionId,
    taskId: input.taskId,
    attemptNumber: input.attemptNumber,
    routerSelectedWorker: input.routedWorkerId ?? null,
    reviewProvider: input.provider ?? null,
    reviewModel: input.model ?? null,
    attributionKey: input.attributionKey ?? null,
    durationMs: Date.now() - input.startedAtMs,
    failureStage: input.stage,
    errorClass: error instanceof Error ? error.name : typeof error,
    errorCode: stableReviewError(error),
    errorMessageRedacted:
      error instanceof Error ? firstLineRedacted(error.message).slice(0, 500) : null,
    stackAvailable: error instanceof Error && Boolean(error.stack),
    /* First frames only: enough to locate, not enough to leak a filesystem layout. */
    stackHead:
      error instanceof Error && error.stack
        ? error.stack.split("\n").slice(1, 4).map((l) => l.trim())
        : null,
  };
}

function stableReviewError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "QUALITY_CONTROL_REVIEW_ABORTED";
  }
  /* Keep a fleet problem legible instead of filing it as a review failure. */
  if (error instanceof Error && error.message.startsWith(QUALITY_CONTROL_NO_ELIGIBLE_WORKER)) {
    return QUALITY_CONTROL_NO_ELIGIBLE_WORKER;
  }
  return "QUALITY_CONTROL_REVIEW_FAILED";
}

export class QualityControlService {
  constructor(private readonly deps: QualityControlServiceDeps) {}

  async registerExecution(input: RegisterExecutionInput): Promise<void> {
    const result = await this.deps.executionResults.getByWorkflowId(input.workflowId);
    const attempt = await this.deps.dispatchAttempts.getByWorkflowId(input.workflowId);
    if (!result || !attempt) {
      throw new Error("QUALITY_CONTROL_EXECUTION_NOT_FOUND");
    }

    await this.deps.qualityJobs.register({
      ...input,
      executionResultId: result.id,
      executionAttempt: attempt.attempt,
    });
  }

  async processPending(missionId: string, signal?: AbortSignal): Promise<void> {
    let replanRequested = false;
    await this.deps.qualityJobs.recoverUnregistered(missionId);
    /*
     * DEFECT 36: complete every ACCEPT whose governed integration has since resolved. This is
     * the step that makes the dependency satisfied — and it queues the durable wake-up that
     * lets the canonical readiness authority admit the dependents.
     */
    await this.deps.qualityJobs.settleAccepted(missionId);
    for (;;) {
      signal?.throwIfAborted();
      await this.deps.assertOwned?.(missionId, signal);
      const ownerToken = `quality-${randomUUID()}`;
      const job = await this.deps.qualityJobs.claimNext(
        missionId,
        ownerToken,
        QUALITY_CONTROL_LEASE_MS,
      );
      if (!job) {
        if (replanRequested) throw new Error("QUALITY_CONTROL_REPLAN_READY");
        return;
      }

      try {
        if (job.state === "reviewing") {
          if (job.reviewAttemptCount > MAX_REVIEW_ATTEMPTS) {
            const existing = await this.deps.reviewDecisions.getByWorkflowId(job.workflowId);
            if (!existing) {
              // Reviewer outage, not a worker failure: park the review (worker
              // result and task state are left untouched) and retry later.
              await this.deps.qualityJobs.markReviewUnavailable(
                job.workflowId,
                ownerToken,
                "QUALITY_CONTROL_REVIEW_UNAVAILABLE",
                this.deps.reviewUnavailableCooldownMs ?? REVIEW_UNAVAILABLE_COOLDOWN_MS,
              );
              continue;
            }
          }
          const review = await this.review(job.workflowId, signal);
          signal?.throwIfAborted();
          await this.deps.assertOwned?.(missionId, signal);
          await this.deps.qualityJobs.saveDecision(job.workflowId, ownerToken, {
            review,
            action: actionForDecision(review.decision),
          });
        }

        signal?.throwIfAborted();
        await this.deps.assertOwned?.(missionId, signal);
        const current = await this.deps.qualityJobs.getByWorkflowId(job.workflowId);
        if (!current?.action) throw new Error("QUALITY_CONTROL_ACTION_NOT_READY");
        const review = current.reviewDecisionId
          ? await this.deps.reviewDecisions.getById(current.reviewDecisionId)
          : null;
        const nextAttempt = current.executionAttempt + 1;
        const taskReviews = await this.deps.reviewDecisions.listByTaskId(current.taskId);
        const reviewCount = taskReviews.length;
        const correctionCount = taskReviews.filter(
          (decision) => decision.decision === "REQUEST_CHANGES",
        ).length;
        const retryCount = taskReviews.filter((decision) => decision.decision === "RETRY").length;
        const exhausted =
          reviewCount > MAX_REVIEW_ATTEMPTS ||
          (current.action === "CORRECT" && correctionCount > MAX_CORRECTION_ATTEMPTS) ||
          (current.action === "RETRY" && retryCount > MAX_EXECUTION_RETRIES);
        if (exhausted) {
          await this.deps.qualityJobs.applyAction(job.workflowId, ownerToken, {
            replanReason: "QUALITY_CONTROL_BUDGET_EXHAUSTED",
            forceEscalate: true,
          });
          continue;
        }
        const originalAttempt =
          current.action === "CORRECT" || current.action === "RETRY"
            ? await this.deps.dispatchAttempts.getByWorkflowId(
                workflowIdForAttempt(current.taskId, 1),
              )
            : null;
        if ((current.action === "CORRECT" || current.action === "RETRY") && !originalAttempt) {
          throw new Error("QUALITY_CONTROL_ORIGINAL_ATTEMPT_NOT_FOUND");
        }
        const feedback = [
          ...(review?.reasons ?? []),
          ...(review?.requestedChanges ?? []).map(
            (change) =>
              `${change.field}: ${change.reason}${change.suggestion ? ` (${change.suggestion})` : ""}`,
          ),
        ].join("\n");
        /*
         * M7.1 — ROUTE the retry before creating it.
         *
         * Routing here, not in the repository: the CapabilityRouter is the one authority
         * (decision 0031) and persistence must not acquire a second opinion about which
         * worker should run something. The routed worker's capacity is then enforced
         * inside `applyAction`'s transaction by the shared guard.
         */
        const retryRouting =
          current.action === "CORRECT" || current.action === "RETRY"
            ? await this.routeRetry(
                current.taskId,
                originalAttempt?.workerKind,
                current.executionAttempt,
                taskReviews,
              )
            : undefined;

        const applied = await this.deps.qualityJobs.applyAction(job.workflowId, ownerToken, {
          ...(current.action === "CORRECT" || current.action === "RETRY"
            ? {
                nextAttempt,
                nextWorkflowId: workflowIdForAttempt(current.taskId, nextAttempt),
                workerId: retryRouting?.workerId,
                routingDecision: retryRouting?.evidence,
                prompt: [
                  "Original task objective:",
                  originalAttempt!.prompt,
                  current.action === "CORRECT"
                    ? "Correction requested by independent review:"
                    : "Retry requested after execution failure:",
                  "Prior review history:",
                  taskReviews
                    .map(
                      (decision, index) =>
                        `${index + 1}. ${decision.decision}: ${decision.reasons.join(" | ")}`,
                    )
                    .join("\n"),
                  feedback,
                ].join("\n"),
              }
            : {}),
          ...(current.action === "REPLAN"
            ? { replanReason: `AUTONOMY_REVIEW_REPLAN:${review?.reasons.join(" | ")}` }
            : {}),
        });
        replanRequested ||= applied.job.action === "REPLAN";
        if (
          (applied.job.action === "CORRECT" || applied.job.action === "RETRY") &&
          applied.dispatchAcquired &&
          this.deps.dispatchPrepared
        ) {
          const nextWorkflowId = workflowIdForAttempt(
            applied.job.taskId,
            applied.job.executionAttempt + 1,
          );
          const attempt = await this.deps.dispatchAttempts.getByWorkflowId(nextWorkflowId);
          if (!attempt) throw new Error("QUALITY_CONTROL_PREPARED_ATTEMPT_NOT_FOUND");
          signal?.throwIfAborted();
          await this.deps.assertOwned?.(missionId, signal);
          await this.deps.dispatchPrepared(attempt, signal);
        }
      } catch (error) {
        /*
         * EMIT BEFORE NORMALISING. `stableReviewError` below returns a stable code the
         * state machine branches on, and collapses everything it does not recognise to
         * QUALITY_CONTROL_REVIEW_FAILED — which is how two missions sat parked for hours
         * with no cause anywhere. The stable code is still what gets persisted; the cause
         * is emitted here so it exists at all.
         */
        console.error(
          JSON.stringify(
            reviewFailureDiagnostic({
              workflowId: job.workflowId,
              missionId: job.missionId,
              taskId: job.taskId,
              attemptNumber: job.reviewAttemptCount,
              stage: this.reviewTrace.stage,
              startedAtMs: this.reviewTrace.startedAtMs || Date.now(),
              ...(this.reviewTrace.routedWorkerId
                ? { routedWorkerId: this.reviewTrace.routedWorkerId }
                : {}),
              ...(this.reviewTrace.provider ? { provider: this.reviewTrace.provider } : {}),
              ...(this.reviewTrace.model ? { model: this.reviewTrace.model } : {}),
              error,
            }),
          ),
        );

        const current = await this.deps.qualityJobs.getByWorkflowId(job.workflowId);
        if (current?.state !== "action_applied" && current?.state !== "escalated") {
          await this.deps.qualityJobs.releaseForRetry(
            job.workflowId,
            ownerToken,
            stableReviewError(error),
          );
        }
        throw error;
      }
    }
  }

  async recover(missionId?: string, signal?: AbortSignal): Promise<void> {
    await this.deps.qualityJobs.recoverUnregistered(missionId);
    const missionIds = missionId
      ? [missionId]
      : await this.deps.qualityJobs.listRecoverableMissionIds();
    for (const candidate of missionIds) {
      signal?.throwIfAborted();
      await this.processPending(candidate, signal);
    }
  }

  /**
   * Chooses the worker for a retry, through the canonical router.
   *
   * The previous attempt's worker is NOT excluded. A worker that died has already lost
   * its health evidence (decision 0033), so the router will not offer it; a worker that
   * merely hit a transient failure is a perfectly good choice, and excluding it would
   * throw away capacity for no reason. Eligibility is the router's job, not a list of
   * grudges kept here.
   */
  private async routeRetry(
    taskId: string,
    workerKind: string | undefined,
    executionAttempt: number,
    taskReviews: readonly { workflowId: string; decision: string }[],
  ): Promise<{ workerId?: string; evidence?: Record<string, unknown> } | undefined> {
    if (!this.deps.capabilityRouter) return undefined;

    /*
     * Required capabilities come from the DURABLE canonical Task, the same source the
     * supervisor routes on (M4). The value that survived the restart is the value that
     * routes.
     */
    const canonicalTask = await this.deps.tasks.getById(taskId);

    /*
     * WHAT EVERY EARLIER ATTEMPT OF THIS TASK DID (decision 0054): which worker ran it, how it
     * ended, what the independent reviewer said. Read from the ledger, so a restarted process
     * escalates exactly as the one that died would have. Attempt history is only READ here.
     */
    const verdictOf = new Map(taskReviews.map((r) => [r.workflowId, r.decision] as const));
    const priorAttempts: PriorAttemptFact[] = [];
    for (let n = 1; n <= executionAttempt; n += 1) {
      const attempt = await this.deps.dispatchAttempts.getByWorkflowId(workflowIdForAttempt(taskId, n));
      if (!attempt) continue;
      priorAttempts.push({
        attempt: n,
        workerId: attempt.workerId,
        failureClass: attempt.failureClass,
        reviewVerdict: verdictOf.get(attempt.workflowId),
      });
    }

    const routing = await this.deps.capabilityRouter.route(
      {
        requiredCapabilities: canonicalTask?.requiredCapabilities ?? [],
        workerKind,
      },
      {
        role: "writer",
        taskType: canonicalTask?.requiredCapabilities?.[0],
        complexity: complexityFromRisk(canonicalTask?.riskClass),
        risk: canonicalTask?.riskClass,
        repositoryMutation: (canonicalTask?.allowedFileScope?.length ?? 0) > 0,
        correctionAttempt: taskReviews.filter((r) => r.decision === "REQUEST_CHANGES").length,
        priorAttempts,
      },
    );

    if (routing.decision === "ROUTED" && routing.worker) {
      return { workerId: routing.worker.id, evidence: routing.evidence };
    }

    if (routing.decision === "NO_ELIGIBLE_WORKER") {
      /* Back-pressure, not a verdict on the task. See the constant's doc. */
      throw new Error(`${QUALITY_CONTROL_NO_ELIGIBLE_WORKER}: ${routing.reason ?? "fleet"}`);
    }

    /* ROUTING_UNCONFIGURED: empty registry, pre-M4 behaviour. */
    return undefined;
  }

  /**
   * Routes the REVIEWER's compute independently of the writer's (decision 0054): a candidate
   * that can review (capability `review`), not the writer's worker, and — when any other model
   * qualifies — not the writer's model. No candidate means the deployment's configured reviewer
   * reviews, exactly as before: this can only add independence, never remove the review.
   */
  private async routeReviewer(
    workflowId: string,
    taskId: string,
  ): Promise<ReviewerCompute | undefined> {
    if (!this.deps.capabilityRouter) return undefined;
    const writer = await this.deps.dispatchAttempts.getByWorkflowId(workflowId);
    const canonicalTask = await this.deps.tasks.getById(taskId);
    const routing = await this.deps.capabilityRouter.route(
      {
        requiredCapabilities: [REVIEW_CAPABILITY],
        excludeWorkerIds: writer?.workerId ? [writer.workerId] : [],
      },
      {
        role: "reviewer",
        taskType: canonicalTask?.requiredCapabilities?.[0],
        complexity: complexityFromRisk(canonicalTask?.riskClass),
        risk: canonicalTask?.riskClass,
        repositoryMutation: false,
        /* Legitimate rejections only: an infrastructure retry is not a harder review. */
        correctionAttempt: (await this.deps.reviewDecisions.listByTaskId(taskId)).filter(
          (d) => d.decision === "REQUEST_CHANGES",
        ).length,
        priorAttempts: [],
        writerWorkerId: writer?.workerId,
      },
    );
    if (routing.decision !== "ROUTED" || !routing.worker) return undefined;
    return {
      workerId: routing.worker.id,
      model: routing.worker.metadata?.model,
      provider: routing.worker.metadata?.provider,
      routing: routing.evidence,
    };
  }

  /**
   * Set while a review attempt is in flight so a failure can say WHERE it died. Reset at
   * the start of each attempt; read by the catch in `processPending`.
   */
  private reviewTrace: {
    stage: ReviewFailureStage;
    startedAtMs: number;
    routedWorkerId?: string;
    provider?: string;
    model?: string;
  } = { stage: "unknown", startedAtMs: 0 };

  private async review(workflowId: string, signal?: AbortSignal) {
    this.reviewTrace = { stage: "load_context", startedAtMs: Date.now() };
    const job = await this.deps.qualityJobs.getByWorkflowId(workflowId);
    if (!job) throw new Error("QUALITY_CONTROL_JOB_NOT_FOUND");
    const existing = await this.deps.reviewDecisions.getByWorkflowId(workflowId);
    if (existing) return existing;

    const [mission, missionTask, task, executionResult] = await Promise.all([
      this.deps.missions.findById(job.missionId),
      this.deps.missions.getMissionTaskById(job.missionTaskId),
      this.deps.tasks.getById(job.taskId),
      this.deps.executionResults.getByWorkflowId(workflowId),
    ]);
    if (!mission || !missionTask || !task || !executionResult) {
      throw new Error("QUALITY_CONTROL_REVIEW_CONTEXT_MISSING");
    }

    signal?.throwIfAborted();
    this.reviewTrace.stage = "route_reviewer";
    const reviewerCompute = await this.routeReviewer(workflowId, task.id);
    this.reviewTrace.routedWorkerId = reviewerCompute?.workerId;
    this.reviewTrace.provider = reviewerCompute?.provider;
    this.reviewTrace.model = reviewerCompute?.model;

    this.reviewTrace.stage = "reviewer_invocation";
    const review = await this.deps.reviewer.review({
      reviewerCompute,
      mission,
      missionTask,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
      },
      executionResult,
      artifacts: executionResult.artifacts ?? [],
      evidence: executionResult.evidence ?? [],
      findings: executionResult.findings ?? [],
      policyContext: {
        executionAttempt: job.executionAttempt,
        priorReviews: await this.deps.reviewDecisions.listByTaskId(job.taskId),
      },
      signal,
    });
    signal?.throwIfAborted();

    this.reviewTrace.stage = "response_validation";
    const normalized = reviewDecisionRecordSchema.safeParse({
      ...review,
      missionId: job.missionId,
      taskId: job.taskId,
      workflowId,
    });
    if (!normalized.success) throw new Error("QUALITY_CONTROL_INVALID_REVIEW");
    return normalized.data;
  }
}
