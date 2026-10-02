# Chief Supervisor — evidence map

The P0 brief asks for twenty named test scenarios. Most of them are invariants of
subsystems that already own them. **Re-asserting another subsystem's invariant here would
make this lane a second authority over it**, and the two copies would drift the first time
that subsystem changed: a lane that tests CORE3's restart semantics has, in practice,
opinions about CORE3's restart semantics.

So the scenarios this lane does not own are listed here against the test that already
proves them, and the scenarios it does own are listed against its own tests. Every path
below was verified to exist at `9cfed88`.

## Owned by this lane

| Scenario | Test |
| --- | --- |
| `SUPERVISOR_PRIORITY_USER_OVER_SELF` | `src/core/supervisor/priority.test.ts` — a maximally favourable SELF_IMPROVEMENT goal scores below a minimally favourable USER goal; the band-spacing test proves it is arithmetic, not luck |
| `SUPERVISOR_CLIENT_OVER_SELF` | `src/core/supervisor/priority.test.ts` |
| `SUPERVISOR_BUDGET_EXHAUSTION` | `src/core/supervisor/portfolio.test.ts` — an exhausted compute budget defers to the window boundary; the governor has no reject outcome |
| `SUPERVISOR_STALE_MEMORY_NOT_LIVE_AUTHORITY` | `src/server/supervisor/objective-read-model.test.ts` — a stale BLOCK review is reported but never overrides a live `succeeded` mission row |
| `SUPERVISOR_E2E` | `src/server/supervisor/objective-e2e.test.ts` — objective → admission → plan → 2 workers → review → one repair cycle → completed, in memory |
| Derived objective lifecycle | `src/core/supervisor/objective-state.test.ts` — every state in the design's table, plus DEGRADED with a populated `unknown[]` |
| No-starvation / reserved slots | `src/core/supervisor/portfolio.test.ts` |

## Owned elsewhere

| Scenario | Owner | Evidence |
| --- | --- | --- |
| `SUPERVISOR_SINGLE_OBJECTIVE` | CORE3 autonomy | `src/server/autonomy/autonomous-mission-runner.test.ts` — one objective drives plan → dispatch → settle under a lease |
| `SUPERVISOR_MULTI_TASK_DAG` | CORE3 supervisor | `src/server/supervisor/postgres-dag-multibranch.integration.test.ts` — a multi-branch DAG settles in dependency order |
| `SUPERVISOR_PARALLEL_DELEGATION` | CORE3 supervisor | `src/server/supervisor/postgres-multiworker-concurrent.integration.test.ts` — independent ready tasks dispatch concurrently to distinct workers |
| `SUPERVISOR_DEPENDENCY_ORDER` | CORE3 readiness | `src/server/supervisor/readiness.ts` + its `readiness-canonical-authority.test.ts` — a task is ready only when every dependency has settled |
| `SUPERVISOR_WORKER_FAILURE` | Quality control | `src/server/usecases/quality-control-service.ts` (`MAX_EXECUTION_RETRIES`) and its tests — a failed execution retries within budget, then escalates |
| `SUPERVISOR_MODEL_FAILURE` | Compute routing (0054) | `src/server/routing/capability-router.ts` tests — a transient provider failure defers, a permanent one fails closed rather than routing to an under-qualified worker |
| `SUPERVISOR_REASSIGNMENT` | Compute routing | `src/server/supervisor/postgres-m54-multiworker-orchestration.integration.test.ts` — a correction is routed with its prior-attempt history |
| `SUPERVISOR_FAILED_REVIEW` | Review | `src/server/review/*` + `src/core/contracts/review.ts` — six exhaustive verdicts; REQUEST_CHANGES/REJECT do not settle a task |
| `SUPERVISOR_REPAIR_CYCLE` | Quality control | `src/server/usecases/quality-control-service.ts` (`MAX_CORRECTION_ATTEMPTS`) and its tests |
| `SUPERVISOR_HUMAN_ESCALATION` | Approvals | `src/server/usecases/record-action-decision.test.ts` (approve/reject an action decision); `src/server/autonomy/core3-natural-review-gate.integration.test.ts` (a mission stops at the gate). **Gap:** `src/app/api/missions/[id]/approval/route.ts` has no test of its own — recorded, not fixed here, because the route belongs to another lane |
| `SUPERVISOR_HUMAN_RESUME` | Autonomy wakeup | `src/server/autonomy/autonomy-wakeup-service.ts` and its tests — an approved mission resumes without a manual relaunch |
| `SUPERVISOR_RESTART_RESUME` | CORE3 supervisor | `src/server/supervisor/postgres-mission-restart.integration.test.ts` |
| `SUPERVISOR_NO_DUPLICATE_EXECUTION` | Dispatch ledger | `src/server/supervisor/supervisor-dispatch-ledger.test.ts`, `postgres-supervisor-dispatch-race.integration.test.ts`, `postgres-concurrent-dispatch-recovery.integration.test.ts` |
| `SUPERVISOR_NO_SELF_APPROVAL` | Reviewer independence | `src/server/autonomy/reviewer-independence.ts` and its tests; `src/core/workforce/delegation.test.ts` (`REVIEWER_NOT_INDEPENDENT`) |
| `SUPERVISOR_NO_AUTHORITY_ESCALATION` | Workforce governance | `src/core/workforce/governance.test.ts` — bounded depth, bounded fan-out, no self-granted permission, tool grants originate from a human |
| `SUPERVISOR_MEMORY_WRITEBACK` | Memory | `src/server/memory/recorders.ts` and its tests — execution results, review decisions and terminal state are written to durable mission memory |

## Gap found while building this map

`src/app/api/missions/[id]/approval/route.ts` — the HTTP surface a human uses to approve or
reject a mission — has no test file. The underlying decision path is covered
(`record-action-decision.test.ts`, `core3-natural-review-gate.integration.test.ts`), but the
route's own authorization, scope check and `awaiting_approval` precondition are not. Reported
here rather than fixed: writing that test from this lane would be this lane taking a position
on another lane's HTTP contract, which is the thing this map exists to avoid.

## What this lane deliberately does not prove

The admission layer is consulted once, before enqueue. It therefore has no test for
pausing, cancelling or holding running work: `RuntimeControlGuard` owns that, and a test
here claiming otherwise would be claiming an authority the code does not have.
