import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";

export type QualityAction = "ACCEPT" | "CORRECT" | "RETRY" | "REPLAN" | "ESCALATE";

export type QualityJobState =
  | "review_pending"
  | "reviewing"
  | "decision_ready"
  /** Reviewer outage after the review budget: recoverable, never fails the worker result. */
  | "review_unavailable"
  | "action_applied"
  | "escalated";

export interface QualityControlJob {
  workflowId: string;
  executionResultId: string;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  executionAttempt: number;
  reviewAttemptCount: number;
  state: QualityJobState;
  reviewDecisionId?: string;
  action?: QualityAction;
  createdAt: Date;
  updatedAt: Date;
  claimToken?: string;
  claimUntil?: Date;
  lastError?: string;
  /**
   * Durable outbox flag, set atomically with the applied action (or
   * escalation): the mission still has to be woken up. Cleared by
   * `completeWakeups` once the wake-up effectively happened.
   */
  wakeupPending?: boolean;
}

export interface RegisterQualityControlInput {
  workflowId: string;
  executionResultId: string;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  executionAttempt: number;
}

export interface RegisterQualityControlResult {
  job: QualityControlJob;
  acquired: boolean;
}

export interface QualityControlRepository {
  register(input: RegisterQualityControlInput): Promise<RegisterQualityControlResult>;
  claimNext(missionId: string, ownerToken: string, leaseMs: number): Promise<QualityControlJob | null>;
  saveDecision(
    workflowId: string,
    ownerToken: string,
    input: { review: ReviewDecisionRecord; action: QualityAction },
  ): Promise<QualityControlJob>;
  applyAction(
    workflowId: string,
    ownerToken: string,
    input: {
      nextAttempt?: number;
      nextWorkflowId?: string;
      prompt?: string;
      replanReason?: string;
      forceEscalate?: boolean;
    },
  ): Promise<{ job: QualityControlJob; dispatchAcquired: boolean }>;
  releaseForRetry(workflowId: string, ownerToken: string, errorCode: string): Promise<void>;
  escalateOwned(workflowId: string, ownerToken: string, reason: string): Promise<void>;
  /** Review budget exhausted by reviewer failures: park the job (recoverable after `cooldownMs`). */
  markReviewUnavailable(
    workflowId: string,
    ownerToken: string,
    reason: string,
    cooldownMs: number,
  ): Promise<void>;
  listWakeupMissionIds(limit?: number): Promise<string[]>;
  listPendingWakeups(missionId: string): Promise<string[]>;
  completeWakeups(workflowIds: string[]): Promise<void>;
  recoverUnregistered(missionId?: string): Promise<number>;
  listRecoverableMissionIds(limit?: number): Promise<string[]>;
  getByWorkflowId(workflowId: string): Promise<QualityControlJob | null>;
  listPending(missionId?: string): Promise<QualityControlJob[]>;
}

export type DispatchPreparedQualityAttempt = (
  attempt: DispatchAttempt,
  signal?: AbortSignal,
) => Promise<void>;
