import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";

export type QualityAction = "ACCEPT" | "CORRECT" | "RETRY" | "REPLAN" | "ESCALATE";

export type QualityJobState =
  | "review_pending"
  | "reviewing"
  | "decision_ready"
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
  recoverUnregistered(missionId?: string): Promise<number>;
  listRecoverableMissionIds(limit?: number): Promise<string[]>;
  getByWorkflowId(workflowId: string): Promise<QualityControlJob | null>;
  listPending(missionId?: string): Promise<QualityControlJob[]>;
}

export type DispatchPreparedQualityAttempt = (
  attempt: DispatchAttempt,
  signal?: AbortSignal,
) => Promise<void>;
