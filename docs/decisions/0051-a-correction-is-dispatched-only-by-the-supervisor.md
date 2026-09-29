# 0051: A correction is dispatched only by the supervisor

## Status
Accepted

## Context

Merging DEFECT 36 (0049, integrated settlement) onto the correction line (0050) produced a tree
in which each half was proven and the combination had never run. The combined natural flow —
A executes, the reviewer asks for changes, the correction runs in its own governed workspace, is
approved, gated, integrated and settled, and only then B runs — did not complete. Two defects,
each visible only in the combined runtime:

- **DEFECT 40 — QC dispatched corrections itself, ungoverned.** The production composition gave
  `QualityControlService` a `dispatchPrepared` that called `container.taskExecution.dispatch`
  directly. A CORRECT/RETRY attempt therefore went to a worker with no governed workspace, was
  marked `dispatched`, and was invisible to the supervisor's 0050 pending-intent claim (which
  only looks at `prepared`). The task never settled and B never ran.
- **DEFECT 41 — a claim outlived the failure that ended it.** Without that bypass, the woken
  supervisor claims the correction (30-minute lease) and asks for its workspace while the
  refused predecessor still holds the task's workspace, waiting for the pending-review sweep to
  gate its REQUEST_CHANGES as a REJECT. `allocateWorkspace` answers `WORKFLOW_COLLISION` —
  correctly. The durable wake-up outbox then retried the wake, as designed, but the retry found
  the intent "claimed" and skipped it, so the wake-up was completed and nothing ever ran it.

## Decision

1. The production QC composes **no `dispatchPrepared`**. CORRECT/RETRY prepares the attempt and
   sets `wakeup_pending` in the same transaction; the woken supervisor claims the intent and
   runs it on the governed path. There is one execution authority for a correction. (The QC
   hook stays for hand-composed, ungoverned harnesses; production does not use it.)
2. `DispatchAttemptRepository.releaseClaim(id, ownerToken)`. The supervisor gives its claim
   back when governing a claimed intent fails **before its workspace is allocated** — i.e.
   before anything can have reached a worker — and still throws, so the outbox retries the
   wake-up. Once allocation succeeded the claim is never released: a failure after that point
   may follow a real dispatch, and releasing it could dispatch twice.

## Evidence

`core3-dag-settlement.integration.test.ts` — `CORRECTION_DAG_E2E`: real container through
`startProductionServices`, real QC and reviewer client (OmniRoute network edge stubbed only),
real gate and applier. Reviews on A are `[REQUEST_CHANGES, APPROVE]`; attempt 2 has its own
workspace and branch; attempt 1 is never applied; B is `draft` with 0 attempts when A's
correction is gated; B's base commit is A's integrated correction; applies are exactly
`[A#2, B]`, both INTEGRATED. No status, review, wake-up, dispatch or gate call is written by
the test.

| Mutation | Result |
|---|---|
| Production QC dispatches the correction itself again | CORRECTION_DAG_E2E fails |
| The supervisor keeps its claim on a failed allocation | CORRECTION_DAG_E2E fails |

## Known limits

- The supervisor's `reconcilePreparedDispatches` (runtime recovery, stale `prepared` intents)
  still dispatches straight to the dispatcher with no governed workspace — the same bypass as
  DEFECT 40 on a recovery path. Recorded as PREPARED_RECOVERY_BYPASSES_GOVERNANCE.
- A result recorded without the completion callback is registered for review by the recovery
  sweep only after its 30 s guard; the correction flow is therefore slow (~1–2 min) but correct.
