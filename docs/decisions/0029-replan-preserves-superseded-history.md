# 0029: Replanning preserves superseded MissionTask history

## Status
Accepted

## Context
`replacePlan()` had two divergent implementations:

- `InMemoryMissionRepository.replacePlan` preserved `succeeded` MissionTasks,
  marked every other pre-existing MissionTask `superseded`, inserted the new
  plan's tasks as `draft`, and returned all three groups.

- `PostgresMissionRepository.replacePlan` **deleted every** MissionTask row for
  the mission ("for simplicity ... we clean slate", per its own comment) and
  returned only the newly inserted tasks.

The Postgres path was unreachable in practice because the CORE3 goal-lineage
commits made `applyPlan`/`replacePlan` throw `MISSION_HAS_NO_GOAL_ID` for any
mission without a goalId, which is how every existing CORE1/CORE2 integration
test creates missions. Removing that incorrect throw (see mission N11 and
`taskSchema` vs `autonomousTaskSpecSchema`) unmasked the divergence.

`mission-replace-plan.integration.test.ts` encoded the destructive behavior: it
asserted the replaced graph had length 2 and that the failed task was
`undefined` in the result — both true only because the row had been deleted.

## Decision
The in-memory semantics are canonical. `replacePlan()` in every implementation:

1. fails closed with `MISSION_REPLAN_ACTIVE_WORK` if any MissionTask is
   `queued`, `running` or `review_pending`;
2. preserves `succeeded` MissionTasks untouched;
3. transitions every other pre-existing MissionTask to `superseded`;
4. inserts the new plan's tasks as `draft`;
5. returns preserved + superseded + created.

No MissionTask row is ever deleted by a replan.

## Rationale
- A MissionTask that executed is durable evidence. Deleting it destroys audit
  history and orphans its canonical Task and audit entries, violating
  auditability and "no deletion of important persistent data".
- `superseded` already exists as a first-class status in both
  `mission_tasks_status_check` and the `MissionTask` contract. It exists for
  precisely this transition; the Postgres path simply never used it.
- The in-memory behavior is the one the passing Phase 6 and replanning suites
  already exercise, so it is the de facto contract of the runner.
- One canonical authority per concept: two repositories must not disagree on
  what a replan means.

## Consequences
- `mission-replace-plan.integration.test.ts` is updated: instead of asserting
  the failed task is absent, it asserts the stronger property that the task is
  still present with status `superseded`. This is a defect fix, not a test
  weakening — the new assertion constrains behavior more tightly than the old
  one, and the succeeded-preservation and atomic-rollback assertions are kept.
- Replanning is now additive in row count. A mission replanned many times
  accumulates superseded rows. Acceptable: they are bounded by plan size times
  replan count, indexed by mission, and are the audit trail. Revisit only if a
  retention policy becomes necessary.

## Alternatives rejected
- **Postgres excludes superseded from the return value while persisting them.**
  Keeps the old test green, but leaves the two repositories returning different
  graphs for the same call — the duplicate-authority problem this decision
  exists to remove.
- **Keep deleting rows.** Rejected: destroys durable history and contradicts
  the `superseded` status that the schema already defines.
