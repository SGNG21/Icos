import { UNKNOWN, type Maybe, type ObjectiveState } from "@/core/supervisor/contracts";
import { deriveObjectiveState } from "@/core/supervisor/objective-state";
import {
  DEFAULT_PRIORITY_POLICY,
  compareScored,
  scoreObjective,
  type PriorityPolicy,
  type PriorityResult,
} from "@/core/supervisor/priority";
import type { GoalRepository } from "@/server/repositories/ports";

/**
 * OBJECTIVE READ MODEL (decision 0065). READ-ONLY and DERIVED.
 *
 * It answers "what is ICOS doing?" without the reader knowing worker internals. It holds
 * no rule of its own and writes nothing: every field is read from a canonical row or is
 * UNKNOWN. A field is UNKNOWN when the source truth does not exist or cannot be read —
 * never 0, never "", never a plausible stand-in.
 */

export interface ObjectiveProgress {
  readonly tasksTotal: number;
  readonly tasksSettled: number;
}

export interface ObjectiveView {
  readonly objectiveId: string;
  readonly title: string;
  readonly missionId: string | null;
  readonly state: ObjectiveState;
  readonly phase: string;
  readonly priority: PriorityResult;
  readonly progress: Maybe<ObjectiveProgress>;
  readonly assignedWorkers: Maybe<readonly string[]>;
  readonly reviewState: Maybe<string>;
  readonly blockedReason: string | null;
  readonly humanDecisionRequired: boolean;
  readonly cost: Maybe<number>;
  readonly elapsedMs: number;
  readonly latestMeaningfulResult: Maybe<string>;
  readonly degraded: { readonly unknown: readonly string[] } | null;
}

interface MissionRow {
  readonly id: string;
  readonly status: string;
}
interface MissionTaskRow {
  readonly taskId: string;
  readonly status: string;
  readonly workerKind?: string | null;
}
interface ReviewRow {
  readonly taskId: string;
  readonly decision: string;
  readonly reasons: readonly string[];
  readonly createdAt: string;
}

export interface ObjectiveReadModelDeps {
  readonly goals: Pick<GoalRepository, "list">;
  readonly missions: {
    findById(id: string): Promise<MissionRow | null>;
    listTasks(missionId: string): Promise<readonly MissionTaskRow[]>;
  };
  readonly reviews: { listByMissionId(missionId: string): Promise<readonly ReviewRow[]> };
  readonly runtimes: { get(missionId: string): Promise<{ state: string } | null> };
  /**
   * The CANONICAL control authority, read-only. This layer asks RuntimeControlGuard
   * whether a mission is held; it never decides, and never holds anything itself.
   */
  readonly controlHolds: { isHeld(missionId: string): Promise<boolean> };
  /**
   * Operational scope. A permission to READ the projection is not a permission to see
   * EVERY objective: `/api/cockpit` resolves scope on every read and so must this.
   * Fail closed — a visibility check that throws hides the row.
   */
  readonly visibility: {
    /** A goal with no mission has no tasks to scope by: only a global reader may see it. */
    readonly unconvertedVisible: boolean;
    isMissionVisible(
      missionId: string,
      tasks: readonly { readonly taskId: string }[] | null,
    ): Promise<boolean>;
  };
  readonly priorityPolicy?: PriorityPolicy;
  readonly now?: () => Date;
}

/** Rows loaded when the caller names no limit. A read model is a dashboard, not an export. */
export const DEFAULT_OBJECTIVE_LIMIT = 100;
/**
 * Objectives resolved at once. Each costs ~5 queries, so an unbounded `Promise.all` over
 * every goal is a connection-pool exhaustion behind a single GET — degrading the whole
 * app, not just this route.
 */
export const OBJECTIVE_CONCURRENCY = 8;

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "superseded"]);
/** A verdict that sends work back is what puts an objective in REPAIRING. */
const REPAIR_DECISIONS = new Set(["REQUEST_CHANGES", "RETRY"]);

/** Reading a side fact must never fail the whole projection: an error IS an unknown. */
const soften = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

export async function buildObjectiveReadModel(
  deps: ObjectiveReadModelDeps,
  options: { limit?: number } = {},
): Promise<ObjectiveView[]> {
  const now = deps.now?.() ?? new Date();
  const policy = deps.priorityPolicy ?? DEFAULT_PRIORITY_POLICY;
  const records = await deps.goals.list({ limit: options.limit ?? DEFAULT_OBJECTIVE_LIMIT });

  const resolve = async (record: (typeof records)[number]) => {
      const priority = scoreObjective(policy, record.goal, { now });
      const missionId = record.resultingMissionId;

      if (!missionId) {
        if (!deps.visibility.unconvertedVisible) return null;
        const derived = deriveObjectiveState({
          goalStatus: record.status,
          missionId: null,
          mission: null,
          tasks: null,
          runtime: null,
          pendingApproval: false,
          controlHeld: false,
          tasksAwaitingRepair: null,
        });
        return {
          goal: record.goal,
          result: priority,
          view: baseView(record.goal, null, derived, priority, now),
        };
      }

      const mission = await soften(() => deps.missions.findById(missionId));
      const [tasks, reviews, runtime, controlHeld] = await Promise.all([
        mission ? soften(() => deps.missions.listTasks(missionId)) : Promise.resolve(null),
        soften(() => deps.reviews.listByMissionId(missionId)),
        soften(() => deps.runtimes.get(missionId)),
        soften(() => deps.controlHolds.isHeld(missionId)),
      ]);

      // Fail closed: an unreadable scope, or one that says no, hides the row entirely.
      const visible = await soften(() => deps.visibility.isMissionVisible(missionId, tasks));
      if (visible !== true) return null;

      /*
       * Mission-level approval IS `mission.status === "awaiting_approval"` (see
       * /api/missions/[id]/approval); a task waits via its own status. There is no
       * separate per-mission pending-approval store to consult, so none is invented.
       */
      const pendingApproval = (tasks ?? []).some((t) => t.status === "awaiting_approval");

      const latestByTask = new Map<string, ReviewRow>();
      for (const r of reviews ?? []) {
        const seen = latestByTask.get(r.taskId);
        if (!seen || new Date(r.createdAt) > new Date(seen.createdAt)) latestByTask.set(r.taskId, r);
      }

      const tasksAwaitingRepair =
        tasks === null || reviews === null
          ? null
          : tasks.filter(
              (t) =>
                !TERMINAL_TASK_STATUSES.has(t.status) &&
                REPAIR_DECISIONS.has(latestByTask.get(t.taskId)?.decision ?? ""),
            ).length;

      const derived = deriveObjectiveState({
        goalStatus: record.status,
        missionId,
        mission: mission ? { status: mission.status } : null,
        tasks: tasks ? tasks.map((t) => ({ status: t.status })) : null,
        runtime,
        pendingApproval,
        // null (unreadable) stays null: deriveObjectiveState degrades rather than assert "not held".
        controlHeld,
        tasksAwaitingRepair,
      });

      const latestReview = [...latestByTask.values()].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];

      const view: ObjectiveView = {
        ...baseView(record.goal, missionId, derived, priority, now),
        progress: tasks
          ? {
              tasksTotal: tasks.length,
              tasksSettled: tasks.filter((t) => TERMINAL_TASK_STATUSES.has(t.status)).length,
            }
          : UNKNOWN,
        assignedWorkers: tasks
          ? [
              ...new Set(tasks.map((t) => t.workerKind).filter((k): k is string => Boolean(k))),
            ].sort()
          : UNKNOWN,
        reviewState: latestReview ? latestReview.decision : UNKNOWN,
        humanDecisionRequired: pendingApproval || derived.state === "WAITING_FOR_HUMAN",
        latestMeaningfulResult: latestReview
          ? `${latestReview.decision}: ${latestReview.reasons.join("; ")}`
          : UNKNOWN,
      };

      return { goal: record.goal, result: priority, view };
  };

  /*
   * Bounded concurrency, not `Promise.all` over the whole page: the fan-out is ~5 queries
   * per objective and the pool is shared with the rest of the application.
   */
  const resolved: NonNullable<Awaited<ReturnType<typeof resolve>>>[] = [];
  for (let i = 0; i < records.length; i += OBJECTIVE_CONCURRENCY) {
    const batch = await Promise.all(records.slice(i, i + OBJECTIVE_CONCURRENCY).map(resolve));
    for (const item of batch) if (item !== null) resolved.push(item);
  }

  return resolved.sort((a, b) => compareScored(a, b)).map((v) => v.view);
}

function baseView(
  goal: { id: string; title: string; createdAt: string },
  missionId: string | null,
  derived: ReturnType<typeof deriveObjectiveState>,
  priority: PriorityResult,
  now: Date,
): ObjectiveView {
  return {
    objectiveId: goal.id,
    title: goal.title,
    missionId,
    state: derived.state,
    phase: derived.phase,
    priority,
    progress: UNKNOWN,
    assignedWorkers: UNKNOWN,
    reviewState: UNKNOWN,
    blockedReason: derived.blockedReason,
    humanDecisionRequired: derived.state === "WAITING_FOR_HUMAN",
    /*
     * No CORE3 execution record carries a cost today (there is no cost column on
     * task_execution_results). Reporting 0 would be a fabricated measurement.
     */
    cost: UNKNOWN,
    elapsedMs: now.getTime() - new Date(goal.createdAt).getTime(),
    latestMeaningfulResult: UNKNOWN,
    degraded: derived.unknown.length > 0 ? { unknown: derived.unknown } : null,
  };
}
