# 0049: A dependency is satisfied by the prerequisite's integrated settlement, not by its review

## Status
Accepted — closes DEFECT 36.

Numbering: 0046, 0047 and 0048 are taken on the peer self-development line; this decision is 0049 to avoid a
collision when the lines meet.

## Context

The canonical readiness authority is `computeReadyTasks` (`src/server/supervisor/readiness.ts`,
decision 0030): a task is ready when it is `draft` and every `dependsOn` MissionTask has reached
`CANONICAL_COMPLETION_STATUS = "succeeded"`. That module already states the rule: "only canonical
persisted completion" advances the DAG. The authority was right; one WRITER of `succeeded` was not.

### Old state transition (reproduced before the fix by `core3-dag-settlement.integration.test.ts`)

```
A draft → queued (supervisor prepare) → executes in its governed workspace
  → workspace ready_for_integration, MissionTask A review_pending (QC register)
  → reviewer APPROVE persisted → QC applyAction(ACCEPT):
        MissionTask A = succeeded, Task A = succeeded, wakeup_pending = true      ← one transaction
  → same recovery tick, QC sweeper delivers the wake-up → supervisor.run
        → computeReadyTasks sees A `succeeded` → B prepared + allocated + dispatched
  → only THEN, later in the same tick, the pending-review gate sweep gates and integrates A
```

A: which event woke dependents — QC's ACCEPT (review approval). B: why before integration —
`sweepAll` runs the QC/autonomy sweep before the pending-review gate sweep (decision 0045), and
ACCEPT itself declared canonical completion, although since decision 0044 an approval is only the
INPUT of the gate. Observed effects: with disjoint scopes B's workspace is based on the pre-A target
(its gate answers `NEEDS_REBASE`, which nothing resolves; the reproduction's B worker, which requires
A's file, fails); with overlapping scopes B's allocation is refused `OWNERSHIP_CONFLICT`. Equally
wrong: an APPROVE whose integration was REJECTED or could not apply still left A `succeeded`.

C: what "dependency satisfied" must mean — for governed work, the accepted commit is contained in its
integration target. For ungoverned work (no workspace for the workflow), review acceptance remains
the completion, unchanged.

## Decision

1. **No new status, no second readiness engine.** `succeeded` keeps its meaning — canonical
   completion — and `computeReadyTasks` is unchanged. What changes is WHEN it is written.
2. **QC's ACCEPT defers completion for governed work.** `applyAction(ACCEPT)` asks the
   `IntegrationSettlementPort` where the workflow's integration stands:
   `UNGOVERNED` or `INTEGRATED` → `succeeded` (as before); `REJECTED` → `failed`; `PENDING` → the
   action is recorded (`action_applied`) and the MissionTask stays in flight (`review_pending`).
3. **Settlement is observed from durable state.** `QualityControlRepository.settleAccepted()` runs at
   the start of every QC pass (`processPending`). For each applied ACCEPT whose MissionTask is still
   in flight, it asks the port; on a definitive answer it writes the MissionTask + Task status AND the
   QC wake-up outbox flag in ONE transaction. `listRecoverableMissionIds` lists missions holding such
   an ACCEPT, so the production recovery sweep keeps observing them after a restart.
4. **Integrated is asked of git.** `WorkspaceIntegrationSettlement` (workspace manager + git):
   INTEGRATED iff a workspace for the workflow is `accepted` AND its `sourceCommit` is an ancestor of
   its integration target — the same evidence the IntegrationApplier uses for `ALREADY_INTEGRATED`.
   `accepted` alone is not enough (NEEDS_REBASE / RACE_LOST keep it accepted), and a release alone is
   not enough (a REJECT is also reaped). REJECTED only when every workspace was reaped unaccepted.
5. **Registration never revives a task that left flight.** QC's `register()` / `recoverUnregistered()`
   used to set the MissionTask to `review_pending` unconditionally; a task cancelled while its result
   awaited registration was silently brought back, then settled `succeeded` once integrated. The
   update is now restricted to in-flight statuses (found by the "cancelled while awaiting review"
   proof).
6. **Wiring is in the container only.** The port is passed to the QC repository where the container
   builds it, so every QC service instance (scheduler, callback, harness) gets the same semantics.
   `SupervisorService`, `WorkspaceExecutionCoordinator` and `production-services.ts` are untouched.

### New state transition

```
A executes → review_pending → APPROVE → ACCEPT recorded (A stays review_pending, B not ready)
  → pending-review gate sweep: gate ACCEPT → applier INTEGRATED → workspace reaped
  → next QC pass: settleAccepted observes INTEGRATED →
        MissionTask A = succeeded, Task A = succeeded, wakeup_pending = true      ← one transaction
  → QC sweeper delivers the wake-up → supervisor.run → computeReadyTasks admits B
  → B prepared (dispatch ledger: exactly one acquirer) → B allocated FROM the integrated target
```

Latency cost: one recovery tick between integration and B's admission.

## Exactly-once and durability

- Settlement is a conditional update (`status in ('queued','running','review_pending')`): concurrent
  or repeated sweeps settle once; a task that left flight (e.g. `cancelled`) is never resurrected.
- Status and wake-up commit together; a crash after settlement is resumed by the outbox, a crash
  after integration but before settlement is resumed by `listRecoverableMissionIds`.
- B's dispatch remains protected by the dispatch ledger (`prepare` → `acquired`) and B's workspace by
  the workspace lease/fencing token. No process-local state participates in correctness.

## Evidence

`src/server/autonomy/core3-dag-settlement.integration.test.ts` (dedicated database, real production
composition, OmniRoute network edge is the only double):
- TWO_TASK_DAG_E2E — A ready / B blocked; A executes; B blocked while A awaits review; A's APPROVE
  gated while B is still `draft` with zero attempts; A integrated once; B admitted automatically,
  allocated from A's integrated commit, reviewed, integrated; one attempt, one gate, one apply each.
- Negative: REQUEST_CHANGES; review BLOCK (A failed); APPROVE + gate REJECT (A failed); APPROVE +
  NEEDS_REBASE (A pending); A cancelled before start; A cancelled while awaiting review then
  integrated — B never admitted in any of them.
- Durability: integrated-but-unsettled is not a satisfied dependency; restart after A's integration
  admits B once in the new process; duplicate sweeps (concurrent + sequential) and two concurrent
  reconciler processes admit and dispatch B exactly once.
- Unit: `integration-settlement.test.ts` (port semantics).
Mutation results: see "Mutation evidence" below. (`audit/self-build-bootstrap/STATE.md` is the shared
self-build ledger edited by the peer line; its DEFECT_36 entry is updated when the lines meet.)

## Mutation evidence

Each mutation applied alone, the targeted proofs run on a dedicated database, then restored. Every one
is killed by a BEHAVIOURAL failure (none by compilation):

| Mutation | Killed by |
|---|---|
| M1 ACCEPT completes on review (dependents wake before settlement) | TWO_TASK_DAG_E2E (B admitted before A's gate), NEEDS_REBASE, integrated-but-unsettled |
| M2 settlement queues no wake-up (readiness never recomputed) | TWO_TASK_DAG_E2E, RESTART (mission never settles) |
| M3 settlement idempotency removed (settles every ACCEPT every pass) | DUPLICATE SWEEPS (re-settles: 1 ≠ 0), cancelled-while-awaiting-review (resurrected) |
| M4 unsettled ACCEPT not rediscovered by the recovery listing | RESTART (B never admitted after restart) |
| M5a REQUEST_CHANGES marks the task succeeded | REQUEST_CHANGES (A succeeded) |
| M5b a rejected integration satisfies the dependency | gate REJECT (A not failed) |
| M6a callback registration revives a cancelled task | cancelled-while-awaiting-review, callback path |
| M6b sweep registration revives a cancelled task | cancelled-while-awaiting-review, sweep path |
| M7 port treats `accepted` as integrated without asking git | `integration-settlement.test.ts` (NEEDS_REBASE/RACE_LOST ⇒ PENDING) |

Not mutated: B's dispatch exactly-once is the pre-existing dispatch ledger (`prepare` → `acquired`),
which this decision does not change; the two-process proof re-asserts it (one B dispatch across both).

## Known limits (open, not closed here)

- **REPAIR_WORKSPACE_DEFECT (pre-existing, separate).** A correction attempt (#2+) has no governed
  workspace, so its workflow is `UNGOVERNED` and its ACCEPT completes immediately, as before this
  decision. After a REQUEST_CHANGES repair a dependent can therefore still be admitted without an
  integration. Closing it means giving the correction its own governed workspace; settlement then
  applies unchanged, keyed by workflow.
- **STUCK_EXECUTION_CAPACITY_DEFECT (pre-existing, separate).** Governed attempts stay `dispatched`
  and keep their worker slot; the proofs register workers with `maxConcurrency: 2`.
- **Synchronous gate path.** If a review already exists when execution ends, the coordinator gates
  inline and the supervisor marks the task `succeeded` on gate ACCEPT even if the apply answered
  NEEDS_REBASE. Rare since 0044 (reviews are written after execution); left to the coordinator owner.
- The self-development coordinator (M10) still gates directly and writes `succeeded` itself; it does
  not route through QC and is unaffected by this decision.
