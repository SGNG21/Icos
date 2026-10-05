# 0070 — Chief binds brains to CORE3 task ids, at first routing, through the one compute seam

- Status: accepted (lane `feat/fable5-product-layer`, P0 of the owner's 2026-10-05 decision)
- Date: 2026-10-05
- Extends: 0057 (digital workforce), 0066 (seven planes, BRAIN ≠ WORKER), 0068 (brains are human acts)
- Closes: the blocking finding of `docs/reports/2026-10-05-twelve-brain-load-bearing-audit.md`

## Numbering hazard

Central owned `..0068`; this lane claims `0069` and `0070`. No other worktree claimed either at
the time of writing (checked across all worktrees). Re-check at integration.

## Context

Twelve brains were seeded, certified and governed on the live database. Chief delegated ten
assignments on five missions. Governance refused fourteen requests for real. And **zero**
dispatch attempts carried a brain, because Chief delegated at ignition — before the planner
had produced a single task — so its assignments could only name stages
(`<mission>:research`), while `workforceTaskCompute.forTask` matches `a.taskId ===
missionTask.taskId`, a CORE3 id (`task-…`). The seam was composed, unit-tested with matching
ids, and structurally unable to match in production.

The owner's constraints: one canonical bridge, no second mapping authority, durable
assignment, no string-convention join, no caller spoofing, retry/resume preserve the
assignment, reviewer and recovery distinct from builder and research.

## Decision

1. **The assignment row is the binding.** `workforce_assignments.task_id` carries the CORE3
   task id for every task assignment. No new table, no migration: the column existed, it held
   the wrong identity.

2. **Chief delegates per task, lazily, at the first routing of any task of the mission.**
   `boundTaskCompute` (`src/server/workforce/mission-binding.ts`) wraps the existing
   `WorkforceTaskCompute`: `forTask` first ensures the mission is delegated — mission and tasks
   read as CORE3 persisted them, goal loaded, `ChiefDelegation.delegateGoal(goal, missionId,
tasks)` — then defers to the inner seam, unchanged. The ignition-time delegation is removed.
   Delegation therefore happens AFTER the plan exists and BEFORE the first dispatch, inside the
   supervisor's own pass, on every path that dispatches.

3. **The binding rule is deterministic and narrow.** A task that declares a capability goes to
   the plan stage(s) carrying that capability (a `code_write` task in self-improvement binds
   Evolution AND Builder; `forTask` composes the strictest). A task that declares none — 23 of
   the 26 live tasks — belongs to the work class's **lead** brain, the wave-0 stage: Planner for
   a software objective, Evolution for self-improvement, Recovery for a repair, Business for a
   client or revenue objective, Research by default. A capability no stage covers is reported
   `unbound`, never guessed to the lead. The reviewer is bound under its own non-task key
   (`<mission>:review`) and read by the ReviewerService, never by the dispatcher.

4. **Idempotent per (task, brain); replan-aware.** Chief skips a pair that already has a
   non-cancelled assignment. A per-process fingerprint of the task set makes a routing pass
   free when nothing changed and re-binds when a replan adds tasks. `planDelegation` itself
   deduplicates nothing, which is why the guard is Chief's.

5. **Spoof-proof by construction.** Nothing reads a brain id from a plan, a prompt, a task row
   or a request: the brain comes from `planObjectiveDelegation` (policy) and is admitted by
   `WorkforceService.delegate` (governance) under the `core3-dispatch` system principal acting
   as brain-chief, the only principal whose direct reports the eleven brains are. API routes
   expose no assignment field.

6. **The dispatch records what the brain did.** `dispatch_attempts.routing_decision.workforce`
   = `{ assignmentIds, agentIds, complexityFloor, complexityRaised, capabilitiesAdded }`, on the
   routed path AND on the unconfigured-router path, so "a brain governed this" and "a brain
   changed this" are both readable from the row. A brain still only tightens: raise the
   difficulty, add capabilities, hold for approval. Model hints never reach the router.

7. **The reviewer brain is recorded on the review decision.** `ReviewerServiceImpl` reads
   the mission's reviewer assignment at the one choke point every LLM review passes through
   and writes `providerMetadata.routing.workforce = { assignmentId, agentId }` on the
   decision row. It also enters the review's spend scope, but a goal-keyed reservation is
   settled from its key (0066 C2), so the ledger's `brain_id` stays null for reviews; the
   decision row is the durable evidence. A mission that was never delegated reviews exactly
   as before.

8. **Never fatal.** A refusal, a partial delegation or a failure is reported as a structured
   event (`CHIEF_DELEGATION_REFUSED | _PARTIAL | _FAILED`) and the dispatch proceeds
   undelegated, exactly as a goal-less mission does. A planning decision must not strand work
   the owner asked for.

## Consequences

- No schema change. `ChiefDelegation.delegateGoal` takes the tasks; `ChiefDelegationDeps`
  gains the store; `WorkforceRuntime` gains `reviewAssignmentFor`; `PostgresReviewerService`
  takes an optional reviewer-brain resolver; `container.ts` composes the workforce before the
  reviewer. `IgniteAutonomousMissionDeps.delegate` is removed.
- Worker executions do not reach the ledger from the supervisor (durable mission tasks run in
  the Temporal worker process, where no in-process model call is metered), so brain
  attribution for _workers_ is carried by the attempt's routing evidence, not by the ledger;
  the reviewer's is in the ledger.
- `recordExecution` has no production caller: assignments stay `assigned` until the mission's
  release cancels them. That keeps `forTask` matching on retries and resumes, and leaves
  execution evidence on the assignment unrecorded — a known, separate gap.
- Skills declare no worker capabilities (`workerCapabilities: []` throughout the bootstrap), so
  the material effect today is the complexity floor (a `standard`/`deep` skill raises a
  `low`/`medium` task) plus the hold and the evidence. Declaring worker capabilities on skills
  is data the owner can add; it must use the worker registry's vocabulary.

## Proof

- Unit: `chief-delegation.test.ts` (binding rule, per-class leads, real ids through `forTask`,
  idempotency, replan, retry/resume, impostor refused), `mission-binding.test.ts` (lazy bind,
  idempotent, goal-less, refusal/failure non-fatal, partial reported, no foreign field read),
  `supervisor-workforce-compute.test.ts` (evidence on the attempt),
  `reviewer-brain-attribution.test.ts` (evidence on the decision),
  `omniroute-reviewer-extract.test.ts` (fenced or prose-wrapped reviewer JSON is accepted).
- PostgreSQL: `dispatch-bridge.integration.test.ts` — software objective → Planner on the
  task, Builder on the code_write task, attempts carry them and the raised floor, second pass
  binds nothing, fresh process reads the same rows; Evolution / Recovery / Business lead their
  classes; goal-less mission unchanged.
- Live-shaped: `scripts/bridge-live-e2e.ts` on an isolated proof server (see the P0/P1 report).
