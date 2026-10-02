import type { Mission } from "@/core/mission/contracts";
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { WORK_CLASSES, type WorkClass } from "@/core/supervisor/contracts";
import {
  DEFAULT_PRIORITY_POLICY,
  assertPriorityPolicyCoherent,
  classifyObjective,
  scoreObjective,
  type PriorityPolicy,
  type PriorityResult,
} from "@/core/supervisor/priority";
import {
  DEFAULT_PORTFOLIO_POLICY,
  allocate,
  assertPortfolioPolicyCoherent,
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
  /**
   * Launches that are enqueued but have not run yet. They have NO mission row and their
   * goal is still `pending`, so counting live missions alone makes the cap advisory: a
   * conversation approving twenty goals in a minute would see `active = 0` twenty times.
   * Absent ⇒ the pending count is unknown, and an unknown count must not read as zero.
   */
  readonly pendingLaunches?: {
    countByWorkClass(): Promise<Partial<Record<WorkClass, number>>>;
  };
  readonly priorityPolicy?: PriorityPolicy;
  readonly portfolioPolicy?: PortfolioPolicy;
  readonly now?: () => Date;
  /**
   * SÉRIALISE l'admission (verrou C7). Sans elle, `admit` est un check-then-enqueue : plusieurs
   * approbations simultanées observent la MÊME charge, aucune ne voit l'enfilement de l'autre,
   * et toutes passent — un plafond de classe à 1 en admet autant qu'il y a d'appels. Lire,
   * décider et enfiler doivent donc être atomiques les uns par rapport aux autres.
   *
   * Absente, elle retombe sur une sérialisation PAR PROCESSUS ({@link inProcessAdmission}),
   * qui est exacte tant qu'il n'y a qu'un processus — le conteneur en mémoire — et INSUFFISANTE
   * dès qu'il y en a plusieurs. Le conteneur PostgreSQL en fournit une qui tient en base.
   */
  readonly serializeAdmission?: AdmissionSerializer;
}

/** Exécute `fn` en exclusion mutuelle avec toute autre admission du même périmètre. */
export type AdmissionSerializer = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Sérialisation PAR PROCESSUS : une file d'attente de promesses.
 *
 * Ce qu'elle garantit : dans CE processus, deux admissions ne s'entrelacent jamais, donc la
 * seconde voit bien la charge que la première a créée. C'est exact pour le conteneur en
 * mémoire, qui est un processus unique de bout en bout.
 *
 * Ce qu'elle NE garantit PAS : rien du tout entre deux processus. Un déploiement à plusieurs
 * instances doit fournir {@link ObjectiveCoordinatorDeps.serializeAdmission} adossé à la base,
 * sans quoi le plafond redevient advisoire. C'est écrit ici plutôt que supposé ailleurs.
 */
export function inProcessAdmission(): AdmissionSerializer {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    /* Un échec ne doit pas empoisonner la file : la suivante démarre quand même. */
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
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
  private readonly serialize: AdmissionSerializer;

  constructor(private readonly deps: ObjectiveCoordinatorDeps) {
    assertPriorityPolicyCoherent(this.priorityPolicy);
    assertPortfolioPolicyCoherent(this.portfolioPolicy);
    this.serialize = deps.serializeAdmission ?? inProcessAdmission();
  }

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
  private async observePortfolio(
    now: Date,
  ): Promise<{ state: PortfolioState; pendingCountable: boolean }> {
    /*
     * Filtered reads only. `missions.list()` unfiltered is a full table scan on a
     * latency-sensitive write path; the port already accepts a status, so ask it once per
     * status that occupies a slot rather than loading every mission ever run.
     */
    const [goals, ...missionsByStatus] = await Promise.all([
      this.deps.goals.list({ status: "converted" }),
      ...[...ACTIVE_MISSION_STATUSES].map((status) => this.deps.missions.list({ status })),
    ]);

    const activeMissionIds = new Set(missionsByStatus.flat().map((m) => m.id));

    const active = zeroedByClass();
    for (const record of goals) {
      if (!record.resultingMissionId || !activeMissionIds.has(record.resultingMissionId)) continue;
      active[classifyObjective(this.priorityPolicy, record.goal).class] += 1;
    }

    /*
     * Add the launches already enqueued. Without them the cap counts only what has started
     * and never what is about to, which is exactly the burst it exists to bound.
     */
    let pendingCountable = true;
    if (this.deps.pendingLaunches) {
      try {
        const pending = await this.deps.pendingLaunches.countByWorkClass();
        for (const c of WORK_CLASSES) active[c] += pending[c] ?? 0;
      } catch {
        // Unknown is not zero. Fail closed: the caller defers rather than over-admits.
        pendingCountable = false;
      }
    }

    return {
      state: { windowStartedAt: now, active, computeSpent: zeroedByClass() },
      pendingCountable,
    };
  }

  /**
   * ADMISSION SÉRIALISÉE (verrou C7). Tout le corps — observer, décider, enfiler — est dans
   * la section critique. Enfermer seulement la lecture ne servirait à rien : c'est l'écart
   * entre « j'ai observé 0 actif » et « j'ai enfilé » qui laissait deux admissions passer.
   */
  async admit(input: AdmitInput): Promise<AdmissionResult> {
    return this.serialize(() => this.admitSerially(input));
  }

  private async admitSerially(input: AdmitInput): Promise<AdmissionResult> {
    const now = this.deps.now?.() ?? new Date();

    const priority = scoreObjective(this.priorityPolicy, input.goal, { now });
    const { state, pendingCountable } = await this.observePortfolio(now);
    const allocated = allocate(
      this.portfolioPolicy,
      state,
      { class: priority.class, computeUnits: 1 },
      now,
    );
    /*
     * An uncountable pending queue means the observed load is a LOWER BOUND. Admitting on
     * a lower bound is how a cap silently stops capping, so defer instead and let the
     * scheduler bring the objective back when the queue is readable again.
     */
    const decision: typeof allocated =
      allocated.admit && !pendingCountable
        ? {
            admit: false,
            defer: true,
            reason: "CLASS_CONCURRENCY",
            retryAfterMs: this.portfolioPolicy.deferBackoffMs,
            evidence: allocated.evidence,
          }
        : allocated;

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
