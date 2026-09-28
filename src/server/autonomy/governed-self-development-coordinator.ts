import type { FactualOutcome } from "@/core/autonomy/learning-harvester";
import {
  buildPatternFromOutcomes,
  groupOutcomesBySignature,
  harvestLearning,
} from "@/core/autonomy/learning-harvester";
import {
  updateCandidateStatus,
  type ImprovementBacklog,
  type ImprovementCandidate,
} from "@/core/autonomy/improvement-backlog";
import {
  evaluateSelfModification,
  type SelfModificationPolicyInput,
} from "@/core/autonomy/self-modification-policy";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { TaskExecutionResult } from "@/core/contracts/task-execution";
import type { WorkerRegistryPort } from "@/core/contracts/worker-registry";
import type { MissionTask } from "@/core/mission/contracts";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { IntegrationGate } from "@/server/workspace-manager/integration-gate";
import type { IntegrationApplier } from "@/server/workspace-manager/integration-applier";
import type { WorkspaceManager } from "@/server/workspace-manager/manager";
import type { IntegrationReport } from "@/server/workspace-manager/report";

import { decideWorkspaceAllocation } from "@/server/supervisor/workspace-allocation-policy";

import { BoundedRepairController, type RepairCandidate } from "./bounded-repair-controller";
import { ReviewerIndependenceChecker } from "./reviewer-independence";
import type { SelfDevelopmentChain } from "./self-development-chain";

export interface GovernedSelfDevelopmentRequest {
  candidate: ImprovementCandidate;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  policy: SelfModificationPolicyInput;
  /**
   * `false` hands the candidate's lifecycle to the CALLER.
   *
   * A candidate's lifecycle is `proposed -> under_review -> approved|rejected`, and it is
   * explicit and one-way. `process()` governs ONE task, so when a plan has several tasks the
   * first one would finalise the candidate and the second would attempt an illegal
   * `approved -> under_review`. `advance()` therefore owns the transitions across the whole
   * plan and sets this to `false`; every other caller keeps the original behaviour.
   */
  ownsCandidateLifecycle?: boolean;
}

export interface CanonicalExecutionRequest {
  candidate: ImprovementCandidate;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  missionTask: MissionTask;
}

export interface CanonicalRepairRequest extends CanonicalExecutionRequest {
  canonicalWorkflowId: string;
  repairCandidate: RepairCandidate;
  previousReview: ReviewDecisionRecord;
}

export type CanonicalExecutionResult =
  | { status: "UNKNOWN"; reason: string }
  | {
      status: "COMPLETED";
      candidateId: string;
      missionId: string;
      missionTaskId: string;
      taskId: string;
      workspaceId: string;
      workspaceLease: { owner: string; fencingToken: number };
      producerWorkerId: string;
      executionResult: TaskExecutionResult;
    };

/**
 * Narrow handoff to the existing durable dispatch/execution authority.
 * Implementations must return the workflowId persisted by that authority.
 */
export interface CanonicalExecutionHandoff {
  execute(input: CanonicalExecutionRequest): Promise<CanonicalExecutionResult>;
  repair(input: CanonicalRepairRequest): Promise<CanonicalExecutionResult>;
}

export type IndependentReviewerSelection =
  | { status: "UNKNOWN"; candidateId: string; reason: string }
  | { status: "SELECTED"; candidateId: string; reviewerWorkerId: string };

export interface GovernedReviewRequest {
  candidateId: string;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  reviewerWorkerId: string;
  executionResult: TaskExecutionResult;
}

export interface GovernedReviewResult {
  candidateId: string;
  reviewerWorkerId: string;
  decision: ReviewDecisionRecord;
}

/** Selects a factual reviewer and delegates the decision to existing review authority. */
export interface IndependentReviewHandoff {
  selectReviewer(input: {
    candidateId: string;
    producerWorkerId: string;
  }): Promise<IndependentReviewerSelection>;
  review(input: GovernedReviewRequest): Promise<GovernedReviewResult>;
}

export type GovernedSelfDevelopmentState =
  /** The gate accepted but nothing integrated: no applier was composed. */
  | "merge_ready"
  /** The gate accepted AND the canonical branch advanced, exactly once (M10). */
  | "integrated"
  | "policy_denied"
  | "gate_rejected"
  | "human_decision_required";

export interface GovernedSelfDevelopmentOutcome {
  candidateId: string;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  workflowId?: string;
  finalState: GovernedSelfDevelopmentState;
  gateDecision?: IntegrationReport["decision"];
  reason: string;
  repairAttemptsUsed: number;
  completedAt: string;
}

export interface GovernedSelfDevelopmentDependencies {
  backlog: ImprovementBacklog;
  missions: MissionRepository;
  /**
   * Canonical tasks. Needed by `advance()` only, to read the writer's declared
   * `allowedFileScope` — which IS the self-modification policy's `targetPaths`. The scope is
   * not re-derived or guessed here; the plan already declared it (decision 0042).
   */
  tasks?: Pick<TaskRepository, "getById">;
  /**
   * The candidate -> goal -> mission -> plan owner (M11). Supplied, `advance()` can run the
   * WHOLE self-development cycle from an intent; omitted, only `process()` is available and
   * a caller must bring its own ids.
   */
  chain?: Pick<SelfDevelopmentChain, "advance">;
  dispatchAttempts: DispatchAttemptRepository;
  workerRegistry: WorkerRegistryPort;
  execution: CanonicalExecutionHandoff;
  review: IndependentReviewHandoff;
  integrationGate: Pick<IntegrationGate, "integrate">;
  /**
   * APPLIES an accepted result to the canonical branch (M10, decision 0041).
   *
   * Without it this coordinator stopped at "merge-ready only; no merge performed" — it said
   * so in its own outcome message. That is the SAME defect shape as 19: a gate that decides
   * and nothing that acts, so self-development could evaluate its own work and never land it.
   *
   * Optional, so a deployment that has not opted into autonomous integration keeps exactly
   * the previous behaviour. It is the canonical applier, never a second merge path.
   */
  integrationApplier?: Pick<IntegrationApplier, "apply">;
  /** Reaps the workspace after a terminal outcome. Same authority as every other reap. */
  workspaces?: Pick<WorkspaceManager, "cleanup">;
  durableMemory: DurableMemory;
}

export interface GovernedSelfDevelopmentOptions {
  maxRepairAttempts?: number;
  now?: () => Date;
}

type CompletedExecution = Extract<CanonicalExecutionResult, { status: "COMPLETED" }>;

export class GovernedSelfDevelopmentCoordinator {
  private readonly maxRepairAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: GovernedSelfDevelopmentDependencies,
    options: GovernedSelfDevelopmentOptions = {},
  ) {
    this.maxRepairAttempts = options.maxRepairAttempts ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * THE WHOLE CYCLE, FROM AN INTENT (defect 29).
   *
   * `SelfDevelopmentChain` owned candidate -> goal -> mission -> plan. This coordinator owned
   * execution -> review -> gate -> integration -> learning. NOTHING JOINED THEM — the fifth
   * occurrence of this repository's dominant defect shape, and the reason
   * SELF_DEVELOPMENT_E2E could only ever be proven as far as planning.
   *
   * The join lives HERE rather than in a new service, because a new service would be exactly
   * the second self-development authority that must not exist. Nothing below plans, reviews,
   * gates or integrates: the chain plans, `process()` governs one task, and this reads what
   * the plan declared and walks it.
   *
   * IT WALKS THE WHOLE PLAN. A real planner answers a bounded improvement with one task on
   * one run and two on the next, so processing only the first would silently leave the rest
   * executed-but-ungated. The candidate's lifecycle is owned HERE for that reason — one
   * candidate gets one verdict, however many tasks its plan contains.
   */
  async advance(options: { candidateId?: string; actor?: string } = {}): Promise<
    GovernedSelfDevelopmentOutcome | { status: "NO_CANDIDATE"; reason: string }
  > {
    const { chain, tasks } = this.dependencies;
    if (!chain) throw new Error("SELF_DEVELOPMENT_CHAIN_UNAVAILABLE");
    if (!tasks) throw new Error("SELF_DEVELOPMENT_TASK_REPOSITORY_UNAVAILABLE");

    const started = await chain.advance(options.candidateId);
    if (started.status !== "STARTED") return started;

    const { candidate, missionId } = started;
    const actor = options.actor ?? "self-development-coordinator";
    const planned = await this.dependencies.missions.listTasks(missionId);

    const requestFor = async (
      missionTaskId: string,
      taskId: string,
    ): Promise<GovernedSelfDevelopmentRequest> => ({
      candidate,
      missionId,
      missionTaskId,
      taskId,
      /*
       * THE POLICY JUDGES WHAT THE PLAN DECLARED. `allowedFileScope` is the writer's fenced
       * scope (decision 0042), so a plan aiming at a protected path is denied by the
       * EXISTING policy — there is no second notion here of what a change touches.
       */
      policy: {
        targetPaths: [...((await tasks.getById(taskId))?.allowedFileScope ?? [])],
        changeDescription: candidate.description,
        improvementCategory: candidate.category,
        isSelfProposed: true,
        actor,
      },
      ownsCandidateLifecycle: false,
    });

    if (planned.length === 0) {
      /*
       * Planning DEFERRED rather than produced a plan (the ignition usecase swallows a
       * planner failure and leaves the mission task-less). Fail closed: no plan is not an
       * empty plan, and it must never look like completed work.
       */
      const request = await requestFor("", "");
      await this.transitionCandidate(candidate.id, "rejected", actor, "PLAN_HAS_NO_TASK");
      return this.outcome(request, "human_decision_required", "PLAN_HAS_NO_TASK", 0);
    }

    let last: GovernedSelfDevelopmentOutcome | undefined;
    for (const missionTask of planned) {
      const canonical = await tasks.getById(missionTask.taskId);
      /*
       * ONLY WRITERS ARE GOVERNED HERE, and the SAME policy the supervisor uses decides
       * which those are — not a second reading of riskClass. A read_only task allocates no
       * workspace by design, so there is nothing to lease, review, gate or integrate; it is
       * ordinary autonomous work, settled by the ordinary authority. Reviewing it here would
       * mean inventing a workspace for work that touches nothing.
       */
      const allocation = decideWorkspaceAllocation({
        taskId: missionTask.taskId,
        title: missionTask.title,
        riskClass: canonical?.riskClass,
        allowedFileScope: canonical?.allowedFileScope,
      });
      if (allocation.kind === "NOT_REQUIRED") continue;

      const request = await requestFor(missionTask.id, missionTask.taskId);
      last = await this.process(request);
      if (last.finalState !== "integrated" && last.finalState !== "merge_ready") {
        await this.transitionCandidate(candidate.id, "rejected", actor, last.reason);
        return last;
      }
      /*
       * THE TASK IS DONE AND IT LANDED, so record it — otherwise a dependent task never
       * becomes ready and the rest of the plan can never run. This is not a second review:
       * the gate already decided, and this only writes down what it decided.
       */
      await this.dependencies.missions.updateMissionTaskStatus(
        missionId,
        missionTask.id,
        "succeeded",
      );
    }

    if (!last) {
      /* A plan of pure readers changes nothing, so it cannot be an improvement. */
      const request = await requestFor(planned[0]!.id, planned[0]!.taskId);
      await this.transitionCandidate(candidate.id, "rejected", actor, "PLAN_HAS_NO_WRITER");
      return this.outcome(request, "human_decision_required", "PLAN_HAS_NO_WRITER", 0);
    }

    await this.transitionCandidate(candidate.id, "approved", actor, last.reason);
    return last;
  }

  async process(request: GovernedSelfDevelopmentRequest): Promise<GovernedSelfDevelopmentOutcome> {
    /*
     * "ALREADY IN THE BACKLOG" STOPPED MEANING "ALREADY PROCESSED" (defect 29).
     *
     * This guard was written when the coordinator was the only thing that ever touched the
     * backlog, so any pre-existing candidate had to be a re-submission. `SelfDevelopmentChain`
     * now records its SELECTION first and durably — deliberately, so a crash cannot lose which
     * candidate was chosen — which left every chain-originated candidate `under_review` and
     * refused by this line. The whole cycle was unreachable from an intent.
     *
     * The invariant that actually matters is unchanged: a candidate that has been DECIDED
     * (approved / rejected / implemented / superseded) is never silently reprocessed. A
     * `proposed` or `under_review` candidate is new work or a resume, and every downstream
     * create is idempotent on derived ids, so re-entering is safe.
     */
    const existing = await this.dependencies.backlog.get(request.candidate.id);
    if (existing && existing.status !== "proposed" && existing.status !== "under_review") {
      return this.outcome(
        request,
        "human_decision_required",
        `CANDIDATE_ALREADY_PROCESSED:${existing.status}`,
        0,
      );
    }

    if (!existing) await this.dependencies.backlog.add(request.candidate);

    const correlationError = await this.validateRequestCorrelation(request);
    if (correlationError) {
      return this.finalize(request, "human_decision_required", correlationError, 0);
    }

    const policy = evaluateSelfModification(request.policy);
    if (!policy.allowed || policy.classification !== "allowed") {
      return this.finalize(
        request,
        "policy_denied",
        `POLICY_${policy.classification.toUpperCase()}:${policy.reason}`,
        0,
      );
    }

    if (request.ownsCandidateLifecycle !== false) {
      await this.transitionCandidate(
        request.candidate.id,
        "under_review",
        policy.decidedBy,
        policy.reason,
      );
    }

    const missionTask = await this.dependencies.missions.getMissionTaskById(request.missionTaskId);
    if (!missionTask) {
      return this.finalize(
        request,
        "human_decision_required",
        "CORRELATION_ERROR:mission task disappeared before execution",
        0,
      );
    }

    const initialExecution = await this.dependencies.execution.execute({
      candidate: request.candidate,
      missionId: request.missionId,
      missionTaskId: request.missionTaskId,
      taskId: request.taskId,
      missionTask,
    });
    if (initialExecution.status === "UNKNOWN") {
      return this.finalize(
        request,
        "human_decision_required",
        `EXECUTION_UNKNOWN:${initialExecution.reason}`,
        0,
      );
    }

    const executionError = await this.validateExecutionCorrelation(request, initialExecution);
    if (executionError) {
      return this.finalize(request, "human_decision_required", executionError, 0);
    }
    const canonicalWorkflowId = initialExecution.executionResult.workflowId;

    let currentExecution = initialExecution;
    let currentReview = await this.reviewExecution(request, currentExecution);
    if (!currentReview.ok) {
      return this.finalize(
        request,
        "human_decision_required",
        currentReview.reason,
        0,
        canonicalWorkflowId,
      );
    }

    let repairAttemptsUsed = 0;
    const factualExecutions: TaskExecutionResult[] = [currentExecution.executionResult];
    const factualReviews: ReviewDecisionRecord[] = [currentReview.review];
    if (currentReview.review.decision !== "APPROVE") {
      const repairable = ["REQUEST_CHANGES", "RETRY"].includes(currentReview.review.decision);
      if (!repairable) {
        return this.harvestAndFinalize(
          request,
          factualExecutions,
          factualReviews,
          "human_decision_required",
          `REVIEW_${currentReview.review.decision}`,
          repairAttemptsUsed,
          canonicalWorkflowId,
        );
      }

      const repairController = new BoundedRepairController({
        workerRegistry: this.dependencies.workerRegistry,
        workflowId: canonicalWorkflowId,
        maxAttempts: this.maxRepairAttempts,
        requiredCapability: currentExecution.executionResult.capability,
      });
      let repairDecision = repairController.getFirstCandidate(
        request.missionId,
        request.taskId,
        missionTask,
      );

      for (;;) {
        if (repairDecision.decision !== "RETRY" || !repairDecision.candidate) {
          return this.harvestAndFinalize(
            request,
            factualExecutions,
            factualReviews,
            "human_decision_required",
            `REPAIR_${repairDecision.decision}:${repairDecision.reason}`,
            repairAttemptsUsed,
            canonicalWorkflowId,
          );
        }

        repairAttemptsUsed = repairDecision.candidate.attemptNumber;
        const repairedExecution = await this.dependencies.execution.repair({
          candidate: request.candidate,
          missionId: request.missionId,
          missionTaskId: request.missionTaskId,
          taskId: request.taskId,
          missionTask,
          canonicalWorkflowId,
          repairCandidate: repairDecision.candidate,
          previousReview: currentReview.review,
        });
        if (repairedExecution.status === "UNKNOWN") {
          return this.harvestAndFinalize(
            request,
            factualExecutions,
            factualReviews,
            "human_decision_required",
            `EXECUTION_UNKNOWN:${repairedExecution.reason}`,
            repairAttemptsUsed,
            canonicalWorkflowId,
          );
        }

        const repairedCorrelationError = await this.validateExecutionCorrelation(
          request,
          repairedExecution,
          canonicalWorkflowId,
        );
        if (repairedCorrelationError) {
          return this.harvestAndFinalize(
            request,
            factualExecutions,
            factualReviews,
            "human_decision_required",
            repairedCorrelationError,
            repairAttemptsUsed,
            canonicalWorkflowId,
          );
        }

        currentExecution = repairedExecution;
        factualExecutions.push(currentExecution.executionResult);
        currentReview = await this.reviewExecution(request, currentExecution);
        if (!currentReview.ok) {
          return this.harvestAndFinalize(
            request,
            factualExecutions,
            factualReviews,
            "human_decision_required",
            currentReview.reason,
            repairAttemptsUsed,
            canonicalWorkflowId,
          );
        }
        factualReviews.push(currentReview.review);
        if (currentReview.review.decision === "APPROVE") break;
        if (!["REQUEST_CHANGES", "RETRY"].includes(currentReview.review.decision)) {
          return this.harvestAndFinalize(
            request,
            factualExecutions,
            factualReviews,
            "human_decision_required",
            `REVIEW_${currentReview.review.decision}`,
            repairAttemptsUsed,
            canonicalWorkflowId,
          );
        }

        repairDecision = repairController.getNextCandidate(
          request.missionId,
          request.taskId,
          repairDecision.candidate,
          currentReview.review.reasons.join("; "),
        );
      }
    }

    const gateReport = await this.dependencies.integrationGate.integrate(
      currentExecution.workspaceId,
      {
        review: {
          verdict: "APPROVED",
          reviewer: currentReview.reviewerWorkerId,
        },
        lease: currentExecution.workspaceLease,
      },
    );
    if (!isKnownGateDecision(gateReport.decision)) {
      return this.harvestAndFinalize(
        request,
        factualExecutions,
        factualReviews,
        "human_decision_required",
        `UNKNOWN_GATE_DECISION:${String(gateReport.decision)}`,
        repairAttemptsUsed,
        canonicalWorkflowId,
      );
    }

    if (gateReport.decision !== "ACCEPT") {
      return this.harvestAndFinalize(
        request,
        factualExecutions,
        factualReviews,
        gateReport.decision === "REJECT" ? "gate_rejected" : "human_decision_required",
        `INTEGRATION_GATE_${gateReport.decision}:${gateReport.reasons.join("; ")}`,
        repairAttemptsUsed,
        canonicalWorkflowId,
        gateReport,
      );
    }

    /*
     * ACCEPT -> APPLY -> REAP (M10).
     *
     * The gate granted `accepted`; the canonical applier is what moves the branch, fenced by
     * the SAME workspace lease that authorised the execution. Without an applier composed
     * the outcome stays `merge_ready`, exactly as before — autonomous integration is opted
     * into, never switched on by upgrading.
     */
    if (!this.dependencies.integrationApplier) {
      return this.harvestAndFinalize(
        request,
        factualExecutions,
        factualReviews,
        "merge_ready",
        "INTEGRATION_GATE_ACCEPT:merge-ready only; no applier composed",
        repairAttemptsUsed,
        canonicalWorkflowId,
        gateReport,
      );
    }

    const applied = await this.dependencies.integrationApplier.apply(
      currentExecution.workspaceId,
      { lease: currentExecution.workspaceLease },
    );

    if (applied.status !== "INTEGRATED" && applied.status !== "ALREADY_INTEGRATED") {
      /*
       * NEEDS_REBASE or a lost race. Neither is a failure of the WORK — the target moved —
       * so it goes back for a human or a later attempt rather than being recorded as a
       * rejection of what the worker produced.
       */
      return this.harvestAndFinalize(
        request,
        factualExecutions,
        factualReviews,
        "human_decision_required",
        `INTEGRATION_NOT_APPLIED:${applied.status}`,
        repairAttemptsUsed,
        canonicalWorkflowId,
        gateReport,
      );
    }

    /*
     * Reap only AFTER the commit is contained in the target, and never let a cleanup failure
     * mask a successful integration: the work has landed either way, and a surviving
     * worktree is an operational annoyance, not a correctness problem.
     */
    await this.dependencies.workspaces
      ?.cleanup(
        currentExecution.workspaceId,
        currentExecution.workspaceLease.owner,
        currentExecution.workspaceLease.fencingToken,
      )
      .catch(() => undefined);

    return this.harvestAndFinalize(
      request,
      factualExecutions,
      factualReviews,
      "integrated",
      `INTEGRATION_APPLIED:${applied.status}`,
      repairAttemptsUsed,
      canonicalWorkflowId,
      gateReport,
    );
  }

  private async validateRequestCorrelation(
    request: GovernedSelfDevelopmentRequest,
  ): Promise<string | null> {
    const [mission, missionTask] = await Promise.all([
      this.dependencies.missions.findById(request.missionId),
      this.dependencies.missions.getMissionTaskById(request.missionTaskId),
    ]);
    if (!mission) return "CORRELATION_ERROR:missionId not found";
    if (
      !missionTask ||
      missionTask.missionId !== request.missionId ||
      missionTask.taskId !== request.taskId
    ) {
      return "CORRELATION_ERROR:missionId/missionTaskId/taskId mismatch";
    }
    return null;
  }

  private async validateExecutionCorrelation(
    request: GovernedSelfDevelopmentRequest,
    execution: CompletedExecution,
    canonicalWorkflowId?: string,
  ): Promise<string | null> {
    if (
      execution.candidateId !== request.candidate.id ||
      execution.missionId !== request.missionId ||
      execution.missionTaskId !== request.missionTaskId ||
      execution.taskId !== request.taskId ||
      execution.executionResult.taskId !== request.taskId
    ) {
      return "CORRELATION_ERROR:execution identity mismatch";
    }
    if (
      canonicalWorkflowId !== undefined &&
      execution.executionResult.workflowId !== canonicalWorkflowId
    ) {
      return "CORRELATION_ERROR:canonical workflowId lineage changed";
    }
    const attempt = await this.dependencies.dispatchAttempts.getByWorkflowId(
      execution.executionResult.workflowId,
    );
    if (
      !attempt ||
      attempt.missionId !== request.missionId ||
      attempt.missionTaskId !== request.missionTaskId ||
      attempt.taskId !== request.taskId
    ) {
      return "CORRELATION_ERROR:workflowId is not owned by canonical durable dispatch intent";
    }
    return null;
  }

  private async reviewExecution(
    request: GovernedSelfDevelopmentRequest,
    execution: CompletedExecution,
  ): Promise<
    | { ok: true; review: ReviewDecisionRecord; reviewerWorkerId: string }
    | { ok: false; reason: string }
  > {
    const selected = await this.dependencies.review.selectReviewer({
      candidateId: request.candidate.id,
      producerWorkerId: execution.producerWorkerId,
    });
    if (selected.candidateId !== request.candidate.id) {
      return { ok: false, reason: "CORRELATION_ERROR:reviewer selection candidateId mismatch" };
    }
    if (selected.status === "UNKNOWN") {
      return { ok: false, reason: `REVIEWER_UNKNOWN:${selected.reason}` };
    }

    const independence = new ReviewerIndependenceChecker({
      workerRegistry: this.dependencies.workerRegistry,
      producerWorkerId: execution.producerWorkerId,
      reviewerWorkerId: selected.reviewerWorkerId,
    }).check();
    if (!independence.isIndependent) {
      return {
        ok: false,
        reason: `REVIEWER_INDEPENDENCE_FAILED:${independence.reason}`,
      };
    }

    const reviewed = await this.dependencies.review.review({
      candidateId: request.candidate.id,
      missionId: request.missionId,
      missionTaskId: request.missionTaskId,
      taskId: request.taskId,
      reviewerWorkerId: selected.reviewerWorkerId,
      executionResult: execution.executionResult,
    });
    if (
      reviewed.candidateId !== request.candidate.id ||
      reviewed.reviewerWorkerId !== selected.reviewerWorkerId ||
      reviewed.decision.missionId !== request.missionId ||
      reviewed.decision.taskId !== request.taskId ||
      reviewed.decision.workflowId !== execution.executionResult.workflowId
    ) {
      return { ok: false, reason: "CORRELATION_ERROR:review decision identity mismatch" };
    }
    return {
      ok: true,
      review: reviewed.decision,
      reviewerWorkerId: reviewed.reviewerWorkerId,
    };
  }

  private async harvestAndFinalize(
    request: GovernedSelfDevelopmentRequest,
    executions: TaskExecutionResult[],
    reviews: ReviewDecisionRecord[],
    finalState: GovernedSelfDevelopmentState,
    reason: string,
    repairAttemptsUsed: number,
    workflowId: string,
    gateReport?: IntegrationReport,
  ): Promise<GovernedSelfDevelopmentOutcome> {
    const harvested = await harvestLearning(
      {
        missionId: request.missionId,
        executionResults: executions,
        reviewDecisions: reviews,
      },
      this.dependencies.durableMemory,
    );
    if (harvested.errors.length > 0) {
      return this.finalize(
        request,
        "human_decision_required",
        `LEARNING_FAILED:${harvested.errors.join("; ")}`,
        repairAttemptsUsed,
        workflowId,
        gateReport,
      );
    }
    if (gateReport) {
      const gateHarvestError = await this.harvestGateOutcome(request, workflowId, gateReport);
      if (gateHarvestError) {
        return this.finalize(
          request,
          "human_decision_required",
          gateHarvestError,
          repairAttemptsUsed,
          workflowId,
          gateReport,
        );
      }
    }
    return this.finalize(request, finalState, reason, repairAttemptsUsed, workflowId, gateReport);
  }

  private async harvestGateOutcome(
    request: GovernedSelfDevelopmentRequest,
    workflowId: string,
    report: IntegrationReport,
  ): Promise<string | null> {
    const outcome: FactualOutcome = {
      id: `gate-${request.candidate.id}-${report.commitSha}-${report.decision}`,
      source: "review",
      missionId: request.missionId,
      taskId: request.taskId,
      workflowId,
      outcome: report.decision === "ACCEPT" ? "success" : "failure",
      findings: report.reasons.length
        ? report.reasons.map((message) => ({
            severity: report.decision === "ACCEPT" ? "info" : "warning",
            check: "IntegrationGate",
            message,
            category: "integration_gate",
          }))
        : [
            {
              severity: "info",
              check: "IntegrationGate",
              message: report.decision,
              category: "integration_gate",
            },
          ],
      evidenceRefs: [report.commitSha],
      timestamp: this.now().toISOString(),
      reviewDecision: report.decision,
    };
    const [group] = groupOutcomesBySignature([outcome]);
    if (!group) return "LEARNING_FAILED:IntegrationGate outcome could not be grouped";
    const pattern = buildPatternFromOutcomes(group[0], group[1]);
    const existing = (await this.dependencies.durableMemory.getPatterns({})).find(
      (candidate) => candidate.id === pattern.id,
    );
    if (existing?.sourceOutcomeIds?.includes(outcome.id)) return null;
    if (existing) {
      await this.dependencies.durableMemory.savePattern({
        ...existing,
        occurrenceCount: existing.occurrenceCount + 1,
        outcomeCounts: {
          success: existing.outcomeCounts.success + pattern.outcomeCounts.success,
          failure: existing.outcomeCounts.failure + pattern.outcomeCounts.failure,
          mixed: existing.outcomeCounts.mixed + pattern.outcomeCounts.mixed,
        },
        lastSeenAt:
          existing.lastSeenAt > pattern.lastSeenAt ? existing.lastSeenAt : pattern.lastSeenAt,
        observations: [...new Set([...existing.observations, ...pattern.observations])],
        evidenceRefs: [...new Set([...existing.evidenceRefs, ...pattern.evidenceRefs])],
        sourceOutcomeIds: [
          ...new Set([...(existing.sourceOutcomeIds ?? []), ...(pattern.sourceOutcomeIds ?? [])]),
        ],
        missionIds: [
          ...new Set([...(existing.missionIds ?? []), ...(pattern.missionIds ?? [])]),
        ].sort(),
      });
    } else {
      await this.dependencies.durableMemory.savePattern(pattern);
    }
    return null;
  }

  private async finalize(
    request: GovernedSelfDevelopmentRequest,
    finalState: GovernedSelfDevelopmentState,
    reason: string,
    repairAttemptsUsed: number,
    workflowId?: string,
    gateReport?: IntegrationReport,
  ): Promise<GovernedSelfDevelopmentOutcome> {
    if (request.ownsCandidateLifecycle !== false) {
      /*
       * `integrated` was missing here, so an improvement that REALLY LANDED on the canonical
       * branch was recorded as `rejected` — the terminal state added by M10 was never added
       * to this map. The backlog is the durable record of what ICOS has done to itself, and
       * it said the opposite of the truth.
       */
      const landed = finalState === "merge_ready" || finalState === "integrated";
      const targetStatus = landed ? "approved" : "rejected";
      await this.transitionCandidate(
        request.candidate.id,
        targetStatus,
        "phase8e-coordinator",
        reason,
      );
    }
    return this.outcome(request, finalState, reason, repairAttemptsUsed, workflowId, gateReport);
  }

  private async transitionCandidate(
    candidateId: string,
    status: "under_review" | "approved" | "rejected",
    actor: string,
    notes: string,
  ): Promise<void> {
    const candidate = await this.dependencies.backlog.get(candidateId);
    if (!candidate) throw new Error(`CANDIDATE_NOT_FOUND:${candidateId}`);
    if (candidate.status === status) return;
    await this.dependencies.backlog.update(updateCandidateStatus(candidate, status, actor, notes));
  }

  private outcome(
    request: GovernedSelfDevelopmentRequest,
    finalState: GovernedSelfDevelopmentState,
    reason: string,
    repairAttemptsUsed: number,
    workflowId?: string,
    gateReport?: IntegrationReport,
  ): GovernedSelfDevelopmentOutcome {
    return {
      candidateId: request.candidate.id,
      missionId: request.missionId,
      missionTaskId: request.missionTaskId,
      taskId: request.taskId,
      workflowId,
      finalState,
      gateDecision: gateReport?.decision,
      reason,
      repairAttemptsUsed,
      completedAt: this.now().toISOString(),
    };
  }
}

function isKnownGateDecision(
  decision: IntegrationReport["decision"],
): decision is IntegrationReport["decision"] {
  return ["ACCEPT", "REJECT", "NEEDS_REBASE", "NEEDS_HUMAN_APPROVAL"].includes(decision);
}
