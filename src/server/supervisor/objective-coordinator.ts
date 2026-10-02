import type { Mission } from "@/core/mission/contracts";
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { WORK_CLASSES, type WorkClass } from "@/core/supervisor/contracts";
import {
  DEFAULT_PRIORITY_POLICY,
  classifyObjective,
  scoreObjective,
  type PriorityPolicy,
  type PriorityResult,
} from "@/core/supervisor/priority";
import {
  DEFAULT_PORTFOLIO_POLICY,
  allocate,
  type AllocationEvidence,
  type DeferReason,
  type PortfolioPolicy,
  type PortfolioState,
} from "@/core/supervisor/portfolio";
import type { MissionRepository } from "@/server/mission/ports";
import type { GoalRepository } from "@/server/repositories/ports";
import type { SchedulerService } from "@/server/scheduler/scheduler-service";

/**
 * CHIEF SUPERVISOR — objective admission (decision 0065).
 *
 * A THIN coordinator: it reads facts, calls two pure functions, and enqueues the EXISTING
 * `start_mission` job. It owns no loop, no lease, no retry and no state between calls.
 * Remove it and launches revert to priority 0 and unbounded admission — today's behaviour.
 *
 * It decides ADMISSION only. Work already running is held, paused or cancelled by
 * RuntimeControlGuard and the control plane; this class has no reference to either and
 * cannot stand in for them.
 */

export interface ObjectiveCoordinatorDeps {
  readonly scheduler: Pick<SchedulerService, "enqueue">;
  readonly goals: Pick<GoalRepository, "list">;
  readonly missions: Pick<MissionRepository, "list">;
  readonly priorityPolicy?: PriorityPolicy;
  readonly portfolioPolicy?: PortfolioPolicy;
  readonly now?: () => Date;
}

export interface AdmitInput {
  readonly goal: HighLevelGoal;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly objective: string;
}

export interface AdmissionEvidence {
  readonly priority: PriorityResult;
  readonly allocation: AllocationEvidence;
}

export type AdmissionResult =
  | {
      readonly outcome: "enqueued";
      readonly jobId: string;
      readonly missionId: string | undefined;
      readonly created: boolean;
      readonly priority: number;
      readonly evidence: AdmissionEvidence;
    }
  | {
      readonly outcome: "deferred";
      readonly jobId: string;
      readonly missionId: string | undefined;
      readonly created: boolean;
      readonly priority: number;
      readonly retryAfterMs: number;
      readonly reason: DeferReason;
      readonly evidence: AdmissionEvidence;
    };

/** Missions that still occupy a portfolio slot. */
const ACTIVE_MISSION_STATUSES = new Set<Mission["status"]>([
  "draft",
  "planning",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
]);

const zeroedByClass = (): Record<WorkClass, number> =>
  Object.fromEntries(WORK_CLASSES.map((c) => [c, 0])) as Record<WorkClass, number>;

export class ObjectiveCoordinator {
  constructor(private readonly deps: ObjectiveCoordinatorDeps) {}

  private get priorityPolicy(): PriorityPolicy {
    return this.deps.priorityPolicy ?? DEFAULT_PRIORITY_POLICY;
  }

  private get portfolioPolicy(): PortfolioPolicy {
    return this.deps.portfolioPolicy ?? DEFAULT_PORTFOLIO_POLICY;
  }

  /**
   * Counts the objectives currently occupying a slot, per work class.
   *
   * Compute spend is NOT tracked: no execution record carries a cost today (see the read
   * model's UNKNOWN cost). Reporting 0 spent would be a fabricated measurement, so the
   * window simply starts now and the budget gate is inert until costs exist.
   */
  private async observePortfolio(now: Date): Promise<PortfolioState> {
    const [goals, missions] = await Promise.all([
      this.deps.goals.list({ status: "converted" }),
      this.deps.missions.list(),
    ]);

    const activeMissionIds = new Set(
      missions.filter((m) => ACTIVE_MISSION_STATUSES.has(m.status)).map((m) => m.id),
    );

    const active = zeroedByClass();
    for (const record of goals) {
      if (!record.resultingMissionId || !activeMissionIds.has(record.resultingMissionId)) continue;
      active[classifyObjective(this.priorityPolicy, record.goal).class] += 1;
    }

    return { windowStartedAt: now, active, computeSpent: zeroedByClass() };
  }

  async admit(input: AdmitInput): Promise<AdmissionResult> {
    const now = this.deps.now?.() ?? new Date();

    const priority = scoreObjective(this.priorityPolicy, input.goal, { now });
    const state = await this.observePortfolio(now);
    const decision = allocate(
      this.portfolioPolicy,
      state,
      { class: priority.class, computeUnits: 1 },
      now,
    );

    const evidence: AdmissionEvidence = { priority, allocation: decision.evidence };

    /*
     * Deferral is `runAt` on the SAME durable job: the existing scheduler already orders,
     * leases and retries it. Nothing new holds the objective, and the caller still gets a
     * durable job id and mission id, so a deferred launch is never lost.
     */
    const { job, created } = await this.deps.scheduler.enqueue({
      kind: "start_mission",
      idempotencyKey: input.idempotencyKey,
      payload: { title: input.title, objective: input.objective, goalId: input.goal.id },
      priority: priority.priority,
      ...(decision.admit ? {} : { runAt: new Date(now.getTime() + decision.retryAfterMs) }),
    });

    if (decision.admit) {
      return {
        outcome: "enqueued",
        jobId: job.id,
        missionId: job.missionId,
        created,
        priority: priority.priority,
        evidence,
      };
    }

    return {
      outcome: "deferred",
      jobId: job.id,
      missionId: job.missionId,
      created,
      priority: priority.priority,
      retryAfterMs: decision.retryAfterMs,
      reason: decision.reason,
      evidence,
    };
  }
}
