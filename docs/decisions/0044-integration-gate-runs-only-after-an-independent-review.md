# 0044: The IntegrationGate runs only after an independent review exists

## Status
Accepted

## Context

CORE3 certification contained an artifact. Every proof had to call `approve(c)` — persisting a
review decision — BEFORE calling `supervisor.run(...)`. Without that pre-seed the run could
never reach ACCEPT.

That was not a test convenience. It described the runtime honestly:
`WorkspaceExecutionCoordinator.executeInWorkspace` handed the workspace to the IntegrationGate
in the SAME call that finished execution. At that instant no independent reviewer had run, so
`resolveReview` found nothing, the gate fell through to `NEEDS_HUMAN_APPROVAL`, the supervisor
marked the task failed, and its `finally` released the workspace — destroying the worktree,
the branch and the commit that the reviewer was about to judge.

So the certified path could only ever integrate work whose approval had been fabricated in
advance. That is defect 28, and it is why SELF_DEVELOPMENT_E2E could not get past planning: a
self-developing system has nobody to pre-persist its own approval.

## Decision

Execution and gating become two moments, not one. The coordinator asks the canonical review
authority first:

- **A review exists** → gate immediately, exactly as before. M9 behaviour is unchanged, which
  is what keeps `CORE3_AUTONOMOUS_ORCHESTRATION_CERTIFIED` meaningful across this change.
- **No review exists** → the workspace stays durable and `ready_for_integration`, and the
  result carries `awaitingReview: true`. The task is NOT terminal, the workspace is NOT
  released, and NO gate decision is produced.

`awaitingReview` is deliberately distinct from both success and failure. A boolean with two
states would have forced the missing review into one of them, and both answers are wrong:
"success" is approval without a reviewer, "failure" is permanent human escalation before QC
ever had a chance to run.

The later pass, `gatePendingReview()`, is the same gate over the same workspaces — it gates,
applies, and reaps on INTEGRATED / ALREADY_INTEGRATED / REJECT. There is still ONE
IntegrationGate and ONE review authority; only the ORDER changed.

Rejected alternatives:

- **A self-development-specific integration path.** The fifth occurrence of this repository's
  dominant defect shape would have been designing it in on purpose.
- **Blocking inside `executeInWorkspace` until a review appears.** It holds a runner and a
  lease hostage to a reviewer, and a crash mid-wait loses the work. Durable state does not
  need a process to sit on it.
- **Defaulting a missing review to APPROVE behind a flag.** Silence is never consent.

## Consequences

- `CoordinationResult` gains `awaitingReview?: boolean`; callers that ignore it observe no
  decision and no integration, which is the safe reading.
- The supervisor keeps an awaiting-review task in flight and its workspace alive. A restart
  finds the workspace exactly where it was left, which is what makes the natural order
  recoverable rather than merely correct.
- Reviewer failure or silence remains fail-closed: no review still means no integration, for
  ever, until one exists. REQUEST_CHANGES still enters the existing repair path.

## Evidence

`core3-autonomous-orchestration.integration.test.ts` — 9 proofs, NO pre-seeded review anywhere.
`approve()` is gone; `qcReviews()` runs the real reviewer at the point the runtime would.
Two new proofs:

- **NATURAL ORDER** — run with no review: nothing is integrated, no gate decision exists, the
  workspace survives, and the task is not escalated. Then the reviewer runs, `gatePendingReview`
  gates, and the commit lands.
- **RESTART WHILE AWAITING REVIEW** — the container is destroyed between execution and review.
  A new container recovers the workspace, gates it once, and the target ref advances exactly
  once by git ancestry.

Mutations verified (each restored afterwards):

| Mutation | Result |
|---|---|
| Gate immediately, ignoring the missing review (`if (!pendingReview)` → `if (false)`) | 6 integration + 3 unit proofs fail |
| Missing review resolves to APPROVED | 4 integration + 3 unit proofs fail |
| Release the workspace while awaiting review (`allocated && !awaitingReview` → `allocated`) | 5 CORE3 proofs fail |

Gates: typecheck PASS, build PASS, `git diff --check` PASS, lint 0 errors / 289 warnings
(baseline), unit 1818 PASS, integration 453 PASS / 3 skipped (opt-in E2Es).
Markers re-proven after the change: `MULTI_WORKER_E2E_PASS` (M5.4, 15 proofs) and
`AUTO_SESSION_RECOVERY_PASS` (M7 + chaos) — 51 proofs across 5 files, all green.
