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
import type { ReviewerService } from "@/server/review/ports";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { reviewDecisionRecordSchema } from "@/core/contracts/review";

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

function stableReviewError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "QUALITY_CONTROL_REVIEW_ABORTED";
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
        const applied = await this.deps.qualityJobs.applyAction(job.workflowId, ownerToken, {
          ...(current.action === "CORRECT" || current.action === "RETRY"
            ? {
                nextAttempt,
                nextWorkflowId: workflowIdForAttempt(current.taskId, nextAttempt),
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

  private async review(workflowId: string, signal?: AbortSignal) {
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
    const review = await this.deps.reviewer.review({
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
