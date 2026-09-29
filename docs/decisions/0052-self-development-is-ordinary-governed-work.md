# 0052: Self-development is ordinary governed work

## Status
Accepted

## Context

`GovernedSelfDevelopmentCoordinator` was a second review/gate/integration authority. For each
writer task of a self-development plan it reviewed the execution itself, ran its own bounded
repair loop, called the `IntegrationGate` and the `IntegrationApplier` directly, reaped the
workspace, and wrote the MissionTask `succeeded`. Meanwhile ordinary work had converged on one
path: QC reviews and corrects (0044), the pending-review sweep gates (0045), integrated
settlement completes the task (0049), and a correction is ordinary governed work (0050, 0051).
Two authorities for one decision must be kept in step by care, and care has failed here every
time (SELF_DEVELOPMENT_GATE_PATH_DIVERGENCE).

Its "independent reviewer" was also nominal: it picked a fleet worker that passed the
independence rule and put that id on the gate call, but the review itself came from
`container.reviewer` — the same canonical reviewer QC uses. Converging loses no real control.

Converging exposed two defects on the path self-development now uses:

- **Ungoverned recovery replay.** `SupervisorService.reconcilePreparedDispatches` (called by the
  mission runner's recovery) dispatched every `prepared` intent straight to the dispatcher.
  For a writer's correction attempt that is ungoverned execution: no workspace, no gate, no
  integration. Missions without a runner never hit it, which is why the DAG proofs missed it.
- **Settlement failed open.** 0049 read "no workspace for this workflow" as `UNGOVERNED` and
  completed the task on its ACCEPT. The ungoverned correction above was therefore reported
  `succeeded` although nothing was integrated.

## Decision

1. `advance()` keeps only what nothing else owns: the chain (candidate → goal → mission →
   plan), the self-modification policy on what the plan declared, driving the runtime until the
   mission settles, the candidate's verdict, and learning. It drives `CanonicalGovernedPass` —
   the SAME `CombinedAutonomyRecoverySweeper` and `PendingReviewGateSweeper` instances the
   production recovery scheduler runs, composed once in `composeAutonomyRuntime`.
   `process()`, the per-task review/repair/gate/apply/reap, `CertifiedRuntimeExecutionHandoff`,
   `CanonicalIndependentReview` and `BoundedRepairController` are deleted.
2. Policy is judged after planning (the scope is the plan's). Ignition has already started the
   mission, so a denial CANCELS every unsettled task.
3. A gate verdict of NEEDS_REBASE / NEEDS_HUMAN_APPROVAL stops the drive and returns
   `human_decision_required`: no pass re-gates unchanged inputs. A draft task behind a
   dependency that settled without succeeding is unreachable and counts as settled.
4. `requiresGovernedWorkspace(task)` is the single definition of governed work. Recovery replay
   skips governed intents (the supervisor's `run()` claims and governs them), and settlement
   answers REJECTED — never UNGOVERNED — for a governed task's workflow with no workspace.

## Evidence

`self-development-canonical-path.integration.test.ts` (real container, `composeAutonomyRuntime`;
fakes: planner/worker commands and the OmniRoute network edge):

- SELF_DEV_CANONICAL_E2E: reader → writer plan; both reviewed by QC; one gate, one apply
  (INTEGRATED); settlement observed; target advanced by exactly one commit touching only the
  declared scope; candidate approved; learning recorded.
- REQUEST_CHANGES: the correction (attempt 2) is governed, integrated and settled;
  `repairAttemptsUsed` = 1.
- BLOCK: nothing integrates; candidate rejected; `advance()` returns.
- POLICY DENIED on a protected path: mission stopped; nothing integrates after further passes.

Structural (`core3-natural-review-gate`): the gate and applier are called only by the
workspace coordinator; the self-development coordinator writes no `succeeded` and holds no gate,
applier or cleanup.

| Mutation | Result |
|---|---|
| Recovery replays governed intents | REQUEST_CHANGES proof fails (TASK_FAILED — settlement fails closed) |
| Settlement answers UNGOVERNED for a governed task without workspace | settlement unit test fails |
| No unreachable-dependent detection | BLOCK proof never returns (timeout) |

## Consequences

- There is one review, gate, integration and completion authority for all work, self-proposed
  or not. `SELF_DEVELOPMENT_GATE_PATH_DIVERGENCE` is closed.
- Self-development is as fast as the runtime: an execution recorded without the completion
  callback is picked up by QC after its 30 s guard.
- Open, not fixed here: INLINE_GATE_NEEDS_REBASE_DEFECT, CANCELLED_WORK_INTEGRATION_DEFECT
  (a policy denial now relies on it), STUCK_EXECUTION_CAPACITY_DEFECT.
