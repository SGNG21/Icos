import { createHash } from "node:crypto";

import {
  selectHighestPriorityCandidate,
  updateCandidateStatus,
  type ImprovementBacklog,
  type ImprovementCandidate,
} from "@/core/autonomy/improvement-backlog";
import { HighLevelGoalSchema, type GoalPlanPreview, type HighLevelGoal } from "@/core/contracts/high-level-goal";
import type { GoalRepository } from "@/server/repositories/ports";
import type {
  IgniteAutonomousMissionDeps,
  IgniteAutonomousMissionResult,
} from "@/server/usecases/ignite-autonomous-mission";
import { igniteAutonomousMission } from "@/server/usecases/ignite-autonomous-mission";

/**
 * THE canonical owner of `ImprovementCandidate -> HighLevelGoal -> Mission -> AutonomousPlan`
 * (M11, defect 25 link 1).
 *
 * Before this, nothing owned that chain: `GovernedSelfDevelopmentCoordinator` took
 * `missionId`/`missionTaskId`/`taskId` as INPUT, so a caller had to build them by hand —
 * which is why self-development could never start from an intent.
 *
 * IT OWNS THE CHAIN; IT IMPLEMENTS NONE OF THE LINKS.
 * The goal model, goal repository, mission creation and planner are all existing canonical
 * services, used as they are. There is no second planner, no second mission engine, no
 * second goal model and no second DAG authority here — `igniteAutonomousMission` already
 * performs mission creation, planning and DAG materialisation, and it is called, not
 * reimplemented.
 *
 * IDENTITY IS DERIVED, NOT GENERATED
 * The goal and mission ids are pure functions of the candidate's `identity.contentHash`.
 * That single decision buys idempotence, restart-safety and duplicate-invocation safety at
 * once: a retry computes the same ids, `missions.create` is idempotent on a supplied id, and
 * the goal repository is idempotent on its key. Nothing has to remember whether it already
 * ran, so nothing can be wrong about it after a crash.
 */

/** Length of the hash prefix used in derived ids. Collision-safe enough for a backlog. */
const ID_HASH_LENGTH = 16;

export interface SelfDevelopmentChainDeps {
  backlog: ImprovementBacklog;
  goals: GoalRepository;
  ignite: IgniteAutonomousMissionDeps;
  now?: () => Date;
  /** Recorded as the actor on candidate transitions. */
  actor?: string;
}

export type SelfDevelopmentChainOutcome =
  | {
      status: "STARTED";
      candidate: ImprovementCandidate;
      goalId: string;
      missionId: string;
      ignition: IgniteAutonomousMissionResult;
      /** False when this call reused an existing goal/mission — a safe replay. */
      created: boolean;
    }
  | { status: "NO_CANDIDATE"; reason: string };

/**
 * Derived, deterministic ids. Stable across processes and restarts, and readable enough in
 * git and logs to trace a branch back to the candidate that caused it.
 */
export function selfDevelopmentIds(candidate: ImprovementCandidate): {
  goalId: string;
  missionId: string;
} {
  const digest = createHash("sha256")
    .update(candidate.identity.contentHash)
    .digest("hex")
    .slice(0, ID_HASH_LENGTH);
  return { goalId: `sd-goal-${digest}`, missionId: `sd-mission-${digest}` };
}

export class SelfDevelopmentChain {
  private readonly now: () => Date;
  private readonly actor: string;

  constructor(private readonly deps: SelfDevelopmentChainDeps) {
    this.now = deps.now ?? (() => new Date());
    this.actor = deps.actor ?? "self-development-chain";
  }

  /**
   * Advances one candidate from the backlog into the canonical orchestration chain.
   *
   * `candidateId` is optional: given, it selects that candidate; omitted, it prioritises the
   * backlog itself. Prioritisation reuses `selectHighestPriorityCandidate` — the existing
   * deterministic ordering — rather than inventing a score.
   */
  async advance(candidateId?: string): Promise<SelfDevelopmentChainOutcome> {
    const candidate = candidateId
      ? await this.deps.backlog.get(candidateId)
      : await this.selectNext();

    if (!candidate) {
      return {
        status: "NO_CANDIDATE",
        reason: candidateId
          ? `candidate ${candidateId} not found`
          : "no approved or proposed candidate in the backlog",
      };
    }

    const { goalId, missionId } = selfDevelopmentIds(candidate);

    /*
     * SELECTION EVIDENCE FIRST, and durably. If the process dies after this, the backlog
     * already records that this candidate was chosen and why — so a restart does not silently
     * pick a different one and leave the first in limbo.
     */
    const selected = await this.recordSelection(candidate, goalId, missionId);

    const goalCreated = await this.ensureGoal(selected, goalId);
    const ignition = await igniteAutonomousMission(this.deps.ignite, {
      id: missionId,
      title: selected.title,
      objective: this.objectiveOf(selected),
      goalId,
    });

    /*
     * Lineage, recorded on the goal itself: which mission this goal became. Idempotent, so a
     * replay re-asserts the same edge rather than creating a second one.
     */
    await this.deps.goals.setConverted(goalId, missionId).catch(() => undefined);

    return { status: "STARTED", candidate: selected, goalId, missionId, ignition, created: goalCreated };
  }

  /**
   * The backlog's own ordering, over the candidates that are actionable.
   *
   * IN-FLIGHT WORK COMES FIRST. `under_review` means "already selected and being worked",
   * and after a restart that is precisely the candidate to resume — re-advancing it is safe
   * because every id is derived and every downstream create is idempotent. Starting a NEW
   * improvement while an earlier one is unfinished would leave the first stranded and put two
   * self-development missions in flight at once.
   *
   * Within each tier the backlog's existing deterministic ordering decides; no score is
   * invented here.
   */
  private async selectNext(): Promise<ImprovementCandidate | null> {
    const inFlight = await this.deps.backlog.list({ status: "under_review" });
    const resumable = selectHighestPriorityCandidate(inFlight);
    if (resumable) return resumable;

    const fresh = [
      ...(await this.deps.backlog.list({ status: "approved" })),
      ...(await this.deps.backlog.list({ status: "proposed" })),
    ];
    return selectHighestPriorityCandidate(fresh);
  }

  /**
   * Moves the candidate to `under_review` and records the derived lineage.
   *
   * Idempotent: a candidate already past `proposed` is left where it is, because a replay
   * must not force an invalid transition — the lifecycle is explicit and fail-closed.
   */
  private async recordSelection(
    candidate: ImprovementCandidate,
    goalId: string,
    missionId: string,
  ): Promise<ImprovementCandidate> {
    if (candidate.status !== "proposed") return candidate;

    const moved = updateCandidateStatus(
      candidate,
      "under_review",
      this.actor,
      `selected for self-development: goal ${goalId}, mission ${missionId}`,
    );
    await this.deps.backlog.update(moved);
    return moved;
  }

  /**
   * Creates the goal, or reuses the one a previous run created.
   *
   * Keyed by the candidate's content hash, so the SAME improvement can never produce two
   * goals — including across restarts, where nothing is left in memory to consult.
   */
  private async ensureGoal(candidate: ImprovementCandidate, goalId: string): Promise<boolean> {
    const existing = await this.deps.goals.getByIdempotencyKey(candidate.identity.contentHash);
    if (existing) return false;

    const objective = this.objectiveOf(candidate);
    const goal: HighLevelGoal = HighLevelGoalSchema.parse({
      id: goalId,
      title: candidate.title,
      objective,
      rawInput: candidate.rationale,
      normalizedIntent: objective,
      /*
       * The candidate carries no success criteria of its own, so none are invented here.
       * The canonical planner derives them per task from the objective — that is its job,
       * and fabricating them at this layer would be a second planning authority.
       */
      successCriteria: [],
      /*
       * The candidate's own risk assessment governs the goal. Self-development does not get
       * a more permissive default than any other work.
       */
      riskLevel: "reversible",
      metadata: {
        source: "self-development",
        candidateId: candidate.id,
        category: candidate.category,
        targetComponent: candidate.targetComponent,
      },
      createdAt: this.now().toISOString(),
    });

    /*
     * An EMPTY preview on purpose. The preview is the human-facing shape of a goal; a
     * self-development goal goes straight to the canonical planner via ignition, and
     * inventing tasks here would be a second planner by another name.
     */
    const preview: GoalPlanPreview = {
      goalId,
      missionTitle: candidate.title,
      missionObjective: objective,
      tasks: [],
    };

    await this.deps.goals.create(goal, preview);
    await this.deps.goals.setIdempotencyKey(goalId, candidate.identity.contentHash);
    return true;
  }

  /** The planner's brief. Rationale is included: WHY it is worth doing is part of the work. */
  private objectiveOf(candidate: ImprovementCandidate): string {
    const parts = [candidate.description?.trim(), candidate.rationale?.trim()].filter(Boolean);
    return `${candidate.title}. ${parts.join(" ")}`.trim();
  }
}
