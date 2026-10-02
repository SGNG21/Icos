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
      /**
       * The worker the retry is ROUTED to (M7.1).
       *
       * Before this, a QC retry attempt was created with `worker_id = NULL`: unrouted,
       * and therefore unexecutable by any dispatcher that resolves its worker from the
       * ledger. Optional, because a deployment with no registry routes nothing and must
       * keep its pre-M4 behaviour.
       *
       * When present, the implementation MUST enforce the worker's capacity inside the
       * same transaction, exactly as `prepare()` does. A retry that oversubscribes a
       * worker is the same defect as a dispatch that does.
       */
      workerId?: string;
      /** ROUTING_DECISION evidence for the retry, stored with the attempt (decision 0054). */
      routingDecision?: Record<string, unknown>;
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
  /** Includes missions with an ACCEPT still awaiting its integrated settlement (DEFECT 36). */
  listRecoverableMissionIds(limit?: number): Promise<string[]>;
  /**
   * Completes every ACCEPT whose governed integration has since resolved (DEFECT 36): the
   * MissionTask becomes `succeeded` (integrated) or `failed` (integration rejected), and the
   * mission wake-up is queued in the SAME transaction. Idempotent: only a MissionTask still in
   * flight changes, so a repeated or concurrent sweep settles nothing twice. Returns how many
   * tasks it settled.
   */
  settleAccepted(missionId?: string): Promise<number>;
  getByWorkflowId(workflowId: string): Promise<QualityControlJob | null>;
  listPending(missionId?: string): Promise<QualityControlJob[]>;
  /**
   * Les travaux ESCALADÉS, que `listPending` exclut volontairement puisqu'elle sert aussi
   * d'entrée de reprise : réintégrer `escalated` y ferait re-réviser indéfiniment ce qui attend
   * justement une décision humaine. Méthode soeur, en lecture seule, pour l'affichage — sans
   * quoi ICOS peut demander un humain sans jamais être entendu.
   */
  listEscalated(missionId?: string): Promise<QualityControlJob[]>;
}

/**
 * Where the governed integration of one workflow's work stands (DEFECT 36, decision 0049).
 *
 * - `UNGOVERNED`: no governed workspace exists for the workflow; review acceptance IS the
 *   canonical completion, exactly as before.
 * - `PENDING`: the work is not (yet) contained in its integration target.
 * - `INTEGRATED`: the gate accepted it and the accepted commit is in the target.
 * - `REJECTED`: the workspace was reaped without being integrated.
 */
export type IntegrationSettlement = "UNGOVERNED" | "PENDING" | "INTEGRATED" | "REJECTED";

export interface IntegrationSettlementPort {
  settlementOf(workflowId: string): Promise<IntegrationSettlement>;
}

/** The MissionTask status a settlement grants; `null` means "not settled yet". */
export function completionForSettlement(
  settlement: IntegrationSettlement,
): "succeeded" | "failed" | null {
  if (settlement === "UNGOVERNED" || settlement === "INTEGRATED") return "succeeded";
  if (settlement === "REJECTED") return "failed";
  return null;
}

export type DispatchPreparedQualityAttempt = (
  attempt: DispatchAttempt,
  signal?: AbortSignal,
) => Promise<void>;
