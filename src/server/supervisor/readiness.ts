import type { Mission, MissionTask } from "@/core/mission/contracts";

/**
 * THE canonical task readiness authority for ICOS (mission N13, decision 0030).
 *
 * There is exactly one readiness engine. `AutonomousMissionRunner` previously
 * carried a private `readyDraftTasks()` with the same semantics; both now call
 * `computeReadyTasks`, so readiness can never disagree between the supervisor
 * and the runner.
 *
 * ## Canonical dependency authority
 *
 * Edges come from `MissionTask.dependsOn` (`mission_tasks.depends_on`), and ONLY
 * from there. `tasks.dependencies` on the canonical Task row is explicitly
 * NON-authoritative: it is advisory metadata a caller may set through
 * `POST /api/tasks`, it is never consulted here, and contradictory content there
 * cannot affect any readiness decision.
 *
 * ## Fail closed
 *
 * A task is ready only if its status is explicitly in `READY_ELIGIBLE_STATUSES`.
 * This is an ALLOW-list: a status added to the MissionTask contract in future is
 * NOT runnable until someone deliberately lists it here. The previous deny-list
 * would have silently treated any new status as runnable.
 *
 * A dependency counts as satisfied only when it has reached
 * `CANONICAL_COMPLETION_STATUS`. Nothing else qualifies — not `running`, not
 * `review_pending`, not `superseded`. A worker asserting it finished does not
 * advance the DAG; only canonical persisted completion does (mission N13).
 */

/** The only status that satisfies a dependency. */
export const CANONICAL_COMPLETION_STATUS = "succeeded" as const;

/**
 * The only task statuses that may become ready.
 *
 * Allow-list, deliberately: `draft` is work the DAG has not yet dispatched.
 * Everything else is already in flight, already terminal, or replaced history.
 */
export const READY_ELIGIBLE_STATUSES: ReadonlySet<
  MissionTask["status"]
> = new Set(["draft"]);

/** Mission states in which no task may be dispatched. */
export const TERMINAL_MISSION_STATUSES: ReadonlySet<
  Mission["status"]
> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Tasks whose canonical dependencies are all complete and which are not yet
 * in flight.
 *
 * Pure derivation from persisted state: it holds no internal bookkeeping, so
 * calling it repeatedly is idempotent and a restart recomputes the identical
 * answer from the database. "Unlock" is therefore not an event that can fire
 * twice — exactly-once DISPATCH is enforced separately by the dispatch ledger.
 */
export function computeReadyTasks(
  mission: Mission,
  tasks: MissionTask[],
): MissionTask[] {
  if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
    return [];
  }

  const completed = new Set(
    tasks
      .filter(
        (task) =>
          task.status === CANONICAL_COMPLETION_STATUS,
      )
      .map((task) => task.id),
  );

  /*
   * A dependency pointing at a task that is not in this mission's graph can
   * never be observed complete, so it blocks forever rather than being ignored.
   * Treating an unresolvable edge as satisfied would advance the DAG past work
   * that does not exist.
   */
  return tasks.filter(
    (task) =>
      READY_ELIGIBLE_STATUSES.has(task.status) &&
      task.dependsOn.every((dependencyId) =>
        completed.has(dependencyId),
      ),
  );
}
