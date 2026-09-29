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
import { evaluateSelfModification } from "@/core/autonomy/self-modification-policy";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { MissionTask } from "@/core/mission/contracts";
import type { MissionRepository } from "@/server/mission/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import type { TaskExecutionResultRepository, TaskRepository } from "@/server/repositories/ports";
import type { WorkspaceManager } from "@/server/workspace-manager/manager";
import type { IntegrationReport } from "@/server/workspace-manager/report";

import { decideWorkspaceAllocation } from "@/server/supervisor/workspace-allocation-policy";

import type { SelfDevelopmentChain } from "./self-development-chain";

export type GovernedSelfDevelopmentState =
  /** Every writer's work is INTEGRATED and settled by the canonical authority (0049). */
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

/** A gate verdict the canonical pending-review pass returned for one task. */
export interface GateObservation {
  taskId: string;
  decision: IntegrationReport["decision"];
  reasons: string[];
  commitSha?: string;
}

/**
 * ONE tick of the production runtime — the SAME sweepers the recovery scheduler runs: QC
 * reviews recorded executions, applies its action (CORRECT/RETRY prepare the next attempt),
 * observes integrated settlement (0049) and delivers the durable wake-ups that let the
 * supervisor run whatever became runnable; then the pending-review pass gates reviewed work
 * (0045). Nothing here is self-development specific, which is the point (decision 0052).
 */
export interface CanonicalGovernedPass {
  run(): Promise<GateObservation[]>;
}

export interface GovernedSelfDevelopmentDependencies {
  backlog: ImprovementBacklog;
  missions: MissionRepository;
  /** Canonical tasks: the writer's declared `allowedFileScope` IS the policy's `targetPaths`. */
  tasks: Pick<TaskRepository, "getById">;
  /** The candidate -> goal -> mission -> plan owner (M11). */
  chain: Pick<SelfDevelopmentChain, "advance">;
  pass: CanonicalGovernedPass;
  executionResults: Pick<TaskExecutionResultRepository, "listByTaskIds">;
  reviewDecisions: Pick<ReviewDecisionRepository, "listByTaskId">;
  /** Read-only: the integrated commit, for the gate outcome the learning records. */
  workspaces?: Pick<WorkspaceManager, "list">;
  durableMemory: DurableMemory;
}

export interface GovernedSelfDevelopmentOptions {
  /** How long `advance()` drives the runtime before handing the mission to a human. */
  settleTimeoutMs?: number;
  pollMs?: number;
  now?: () => Date;
}

/** Settled for this observer: nothing will change it without new input. */
const SETTLED: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
  "blocked",
]);

/** A draft task behind a dependency that settled without succeeding can never become ready. */
function unreachable(task: MissionTask, all: MissionTask[], seen = new Set<string>()): boolean {
  if (task.status !== "draft" || seen.has(task.id)) return false;
  seen.add(task.id);
  return task.dependsOn.some((id) => {
    const dep = all.find((t) => t.id === id);
    return (
      !dep ||
      (SETTLED.has(dep.status) && dep.status !== "succeeded") ||
      unreachable(dep, all, seen)
    );
  });
}

/**
 * SELF-DEVELOPMENT IS ORDINARY GOVERNED WORK (decision 0052).
 *
 * This coordinator used to be a second review/gate/integration authority: it reviewed each
 * writer itself, ran its own repair loop, called the IntegrationGate and the applier directly,
 * reaped the workspace and wrote the MissionTask `succeeded`. Every one of those now has ONE
 * canonical owner — QC reviews and corrects, the supervisor governs every attempt, the
 * pending-review pass gates and applies, and integrated settlement completes the task — so
 * the duplicate is deleted rather than kept in step.
 *
 * What remains here is what nothing else owns: turning a candidate into a mission (the
 * chain), judging the plan against the self-modification policy, driving the runtime until
 * the mission settles, and recording the candidate's verdict and the learning.
 */
export class GovernedSelfDevelopmentCoordinator {
  private readonly settleTimeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: GovernedSelfDevelopmentDependencies,
    options: GovernedSelfDevelopmentOptions = {},
  ) {
    this.settleTimeoutMs = options.settleTimeoutMs ?? 60 * 60_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
  }

  async advance(options: { candidateId?: string; actor?: string } = {}): Promise<
    GovernedSelfDevelopmentOutcome | { status: "NO_CANDIDATE"; reason: string }
  > {
    const { chain, missions, tasks } = this.dependencies;
    const started = await chain.advance(options.candidateId);
    if (started.status !== "STARTED") return started;

    const { candidate, missionId } = started;
    const actor = options.actor ?? "self-development-coordinator";
    const planned = await missions.listTasks(missionId);

    if (planned.length === 0) {
      /* Planning DEFERRED: no plan is not an empty plan, and never completed work. */
      return this.conclude(candidate, missionId, undefined, "human_decision_required", "PLAN_HAS_NO_TASK", actor);
    }

    const writers: MissionTask[] = [];
    for (const task of planned) {
      const canonical = await tasks.getById(task.taskId);
      const allocation = decideWorkspaceAllocation({
        taskId: task.taskId,
        title: task.title,
        riskClass: canonical?.riskClass,
        allowedFileScope: canonical?.allowedFileScope,
      });
      if (allocation.kind === "NOT_REQUIRED") continue;
      writers.push(task);

      /*
       * THE POLICY JUDGES WHAT THE PLAN DECLARED (decision 0042 scope). Ignition already
       * started the mission, so a denial must also STOP it: every unsettled task is
       * cancelled, and cancelled work is never integrated.
       */
      const policy = evaluateSelfModification({
        targetPaths: [...(canonical?.allowedFileScope ?? [])],
        changeDescription: candidate.description,
        improvementCategory: candidate.category,
        isSelfProposed: true,
        actor,
      });
      if (!policy.allowed || policy.classification !== "allowed") {
        await this.cancelUnsettled(missionId);
        return this.conclude(
          candidate,
          missionId,
          task,
          "policy_denied",
          `POLICY_${policy.classification.toUpperCase()}:${policy.reason}`,
          actor,
        );
      }
    }

    if (writers.length === 0) {
      /* A plan of pure readers changes nothing, so it cannot be an improvement. */
      return this.conclude(candidate, missionId, planned[0], "human_decision_required", "PLAN_HAS_NO_WRITER", actor);
    }

    const { settled, stuck } = await this.settle(missionId);
    const last = writers[writers.length - 1]!;

    if (stuck) {
      const task = settled.find((t) => t.taskId === stuck.taskId) ?? last;
      await this.recordLearning(candidate, missionId, settled, [stuck]);
      return this.conclude(
        candidate,
        missionId,
        task,
        "human_decision_required",
        `INTEGRATION_GATE_${stuck.decision}:${stuck.reasons.join("; ")}`,
        actor,
        stuck.decision,
      );
    }

    const byId = new Map(settled.map((t) => [t.id, t]));
    const unfinished = settled.find((t) => t.status !== "succeeded");
    const gates = await this.integratedGates(writers);
    await this.recordLearning(candidate, missionId, settled, gates);

    if (unfinished) {
      const reason = SETTLED.has(unfinished.status)
        ? `TASK_${unfinished.status.toUpperCase()}:${unfinished.title}`
        : `NOT_SETTLED:${unfinished.title} is ${unfinished.status}`;
      return this.conclude(candidate, missionId, unfinished, "human_decision_required", reason, actor);
    }

    const writer = byId.get(last.id) ?? last;
    return this.conclude(candidate, missionId, writer, "integrated", "INTEGRATED_AND_SETTLED", actor, "ACCEPT");
  }

  /** Drives the production passes until every task settles, a gate needs a human, or time runs out. */
  private async settle(
    missionId: string,
  ): Promise<{ settled: MissionTask[]; stuck?: GateObservation }> {
    const deadline = this.now().getTime() + this.settleTimeoutMs;
    for (;;) {
      const current = await this.dependencies.missions.listTasks(missionId);
      if (current.every((t) => SETTLED.has(t.status) || unreachable(t, current))) {
        return { settled: current };
      }
      if (this.now().getTime() > deadline) return { settled: current };

      const observed = await this.dependencies.pass.run();
      /*
       * NEEDS_REBASE / NEEDS_HUMAN_APPROVAL are not terminal, but no pass can change them: the
       * pending-review pass does not re-gate unchanged inputs. Hand them to a human now rather
       * than burn the whole timeout.
       */
      const stuck = observed.find(
        (o) =>
          (o.decision === "NEEDS_REBASE" || o.decision === "NEEDS_HUMAN_APPROVAL") &&
          current.some((t) => t.taskId === o.taskId),
      );
      if (stuck) return { settled: await this.dependencies.missions.listTasks(missionId), stuck };

      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async cancelUnsettled(missionId: string): Promise<void> {
    for (const task of await this.dependencies.missions.listTasks(missionId)) {
      if (!SETTLED.has(task.status)) {
        await this.dependencies.missions.updateMissionTaskStatus(missionId, task.id, "cancelled");
      }
    }
  }

  /** The ACCEPT the canonical gate granted each integrated writer, read back from durable state. */
  private async integratedGates(writers: MissionTask[]): Promise<GateObservation[]> {
    const workspaces = (await this.dependencies.workspaces?.list()) ?? [];
    return writers.flatMap((w) => {
      const ws = workspaces.find((s) => s.taskId === w.taskId && s.status === "accepted");
      return ws?.sourceCommit
        ? [{ taskId: w.taskId, decision: "ACCEPT" as const, reasons: [], commitSha: ws.sourceCommit }]
        : [];
    });
  }

  private async recordLearning(
    candidate: ImprovementCandidate,
    missionId: string,
    settled: MissionTask[],
    gates: GateObservation[],
  ): Promise<void> {
    const taskIds = settled.map((t) => t.taskId);
    const executionResults = await this.dependencies.executionResults.listByTaskIds(taskIds);
    const reviewDecisions = (
      await Promise.all(taskIds.map((id) => this.dependencies.reviewDecisions.listByTaskId(id)))
    ).flat();
    const harvested = await harvestLearning(
      { missionId, executionResults, reviewDecisions },
      this.dependencies.durableMemory,
    );
    if (harvested.errors.length > 0) {
      throw new Error(`LEARNING_FAILED:${harvested.errors.join("; ")}`);
    }
    for (const gate of gates) {
      const error = await this.harvestGateOutcome(
        { candidate, missionId, taskId: gate.taskId },
        reviewDecisions.filter((r) => r.taskId === gate.taskId).at(-1)?.workflowId ?? gate.taskId,
        gate,
      );
      if (error) throw new Error(error);
    }
  }

  private async harvestGateOutcome(
    request: { candidate: ImprovementCandidate; missionId: string; taskId: string },
    workflowId: string,
    report: GateObservation,
  ): Promise<string | null> {
    const outcome: FactualOutcome = {
      id: `gate-${request.candidate.id}-${report.commitSha ?? workflowId}-${report.decision}`,
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
      evidenceRefs: [report.commitSha ?? workflowId],
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

  private async conclude(
    candidate: ImprovementCandidate,
    missionId: string,
    task: MissionTask | undefined,
    finalState: GovernedSelfDevelopmentState,
    reason: string,
    actor: string,
    gateDecision?: IntegrationReport["decision"],
  ): Promise<GovernedSelfDevelopmentOutcome> {
    const reviews = task ? await this.dependencies.reviewDecisions.listByTaskId(task.taskId) : [];
    await this.transitionCandidate(
      candidate.id,
      finalState === "integrated" ? "approved" : "rejected",
      actor,
      reason,
    );
    return {
      candidateId: candidate.id,
      missionId,
      missionTaskId: task?.id ?? "",
      taskId: task?.taskId ?? "",
      workflowId: reviews.at(-1)?.workflowId,
      finalState,
      gateDecision,
      reason,
      /* Each review after the first judged a correction. */
      repairAttemptsUsed: Math.max(0, reviews.length - 1),
      completedAt: this.now().toISOString(),
    };
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

}
