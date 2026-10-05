# Product Layer lane — central-integration handoff, 2026-10-05

Branch `feat/fable5-product-layer`, based on central `c0129ae`. Do not merge without the
central integration review; nothing here is merged to `integration/icos-central`.

## What the lane carries (since `c0129ae`)

| Area                       | Commits                       | Files that matter                                                                                                                                     |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch bridge (0070)     | `fdf7f06` `d19e4b6` `bb57ee6` | `workforce/mission-binding.ts`, `workforce/chief-delegation.ts`, `workforce/composition.ts`, `system/production-services.ts`, `supervisor-service.ts` |
| Reviewer brain attribution | `626ca70`                     | `review/reviewer-service.ts`, `review/omniroute-reviewer.ts`, `postgres-reviewer-service.ts`, `container.ts`                                          |
| QC keeps governing brain   | `7f362cb`                     | `usecases/quality-control-service.ts`                                                                                                                 |
| Narrow AUTO_ALLOWED launch | `6627a35`                     | `core/cognitive/turn-policy.ts`, `cognitive/cognitive-runtime.ts`, `conversation-store.ts`, `mission-gateway.ts`                                      |
| Review fixes (this pass)   | see `git log`                 | `mission-binding.ts`, `cognitive-runtime.ts`, decision 0070 open item                                                                                 |

No schema change, no migration. Temporal writer, Runtime Supervisor, OmniRoute topology and
the live DB were not touched by this review pass.

## Independent review — findings

1. **Governance regression (escalated, not decided here).** Central's fail-closed
   `CHIEF_DELEGATION_REVIEWER_UNPLACED` (`7a0f8c2`) was removed when delegation moved from
   ignition to first routing; decision 0070 did not record it. The review gate itself still
   runs on every attempt; only the Reviewer brain's attribution is lost. Fixed internally:
   the distinct event is restored in `mission-binding.ts` and the decision records the open
   item. Owner ruling needed on whether it must HOLD dispatch (would touch the supervisor).
2. **Silent auto-launch failure (fixed).** `submitTurn` swallowed a policy auto-launch error
   and returned the stale `approved` ref while the store held `launching`. It now logs
   `COGNITIVE_AUTO_LAUNCH_FAILED` and returns the durable ref; recovery still launches it.
   Integration test L6 (red before the fix, green after).
3. Reviewed and sound: the policy decider cannot be spoofed (human decisions write the user
   id; the policy id is set only by `launchPolicy`); undeclared/unknown/sensitive goals hold;
   `beginLaunch` keeps launch exactly-once; the bridge never reads a brain id from a plan or
   request; a brain can only tighten routing on both the first attempt and QC retries.

## Evidence (this pass, on the review-fix HEAD)

- Typecheck `tsc --noEmit`: exit 0.
- ESLint on the 55 TS files changed since `c0129ae`: exit 0, no warnings.
- Prettier on changed TS/MD: clean.
- Targeted unit (workforce, review, QC retry, supervisor, cognitive, core cognitive/autonomy):
  41 files, 609 tests passed.
- Targeted PostgreSQL integration on a local throwaway DB: `dispatch-bridge` + `cognitive-mission-launch`,
  2 files, 13 tests passed.
- Full unit suite: 3766 passed, 3 failed, all in files untouched by the lane: two process-tree
  kill tests fail identically on central `c0129ae` in this container; `improvement-backlog`
  "defensive copy" passes in isolation (flaky under load).

## Residual risks

- Per-process binding memo: a partial delegation (capacity) is not retried until a task's
  status changes; the memo map is never pruned (one entry per mission per process).
- `forTask` and `reviewAssignmentFor` scan all tenant assignments linearly.
- Owner items carried from the P0/P1 report: `maxConcurrentAssignments: 5` on live brains,
  skills declare no worker capabilities, `synthesize` after `cancel` refuses
  `CHILDREN_NOT_SETTLED`, the retry-keeps-brain fix is not yet re-run live.
- Expected textual conflicts with central: `supervisor-service.ts`, `container.ts`,
  `production-services.ts`, `quality-control-service.ts`.
