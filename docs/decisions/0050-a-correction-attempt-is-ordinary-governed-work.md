# 0050: A correction attempt is ordinary governed work

## Status
Accepted

## Context

With the self-development cycle running end to end, roughly half of real runs died in the
same place:

```
EXECUTION_UNKNOWN:NO_GOVERNED_WORKSPACE:icos-task-<id>-attempt-2
```

A reviewer answering REQUEST_CHANGES — the ordinary, correct outcome of an independent review
— ended the work outright. The bounded repair controller, the correction prompt, the review
history and the attempt lineage were all built and proven; no correction attempt had ever
reached the certified path.

It looked like one hardcoded line. It was five, each hiding the next, and each visible only
by running the path.

## The five layers

1. **The supervisor invented the attempt number.** `const attemptNumber = 1`,
   unconditionally. `prepare()` is idempotent on that key, so once attempt 1 existed every
   later tick declined to acquire it and returned. Attempt 2 was never prepared.

   The attempt number is not the supervisor's to compute. A pending attempt in the durable
   ledger IS the intent to execute, so the supervisor now claims and governs that one — under
   a lease, so two ticks cannot both run it — and prepares attempt 1 only when there is none.
   It dispatches the ATTEMPT's prompt, not the task's: a correction carries the feedback that
   asked for it, and re-sending the original objective would discard it.

2. **Only `draft` tasks were ready.** `computeReadyTasks` is an allow-list of one status,
   deliberately: a task moves to `queued` the moment its first attempt is prepared, and
   re-running a queued task would double-dispatch it. But a correction belongs to a task long
   past draft, so the loop never looked at it again. The work list is now ready tasks PLUS
   non-terminal tasks that already carry a pending intent. Nothing is double-dispatched,
   because the intent is claimed under a lease.

3. **The refused attempt kept its workspace.** `allocateWorkspace` refuses to bind a second
   workflow id to a task whose workspace is still held — correctly, or two attempts' work
   lands on one branch. The coordinator now settles the refused attempt first: `abandoned`,
   because the gate never ran, then cleanup. The branch SURVIVES, since cleanup only reaps a
   branch already contained in the integration target, so the refused work stays inspectable.

4. **The refused attempt kept its worker's capacity.** Durable load counts non-terminal
   attempts, so a one-slot worker was "fully loaded" by the very correction it was waiting to
   run. The router answered NO_ELIGIBLE_WORKER and the task blocked — for a reason that names
   nothing actually wrong. The refused attempt is now recorded as failed before its successor
   is routed. And an EXISTING intent is not re-routed at all: it already carries the worker it
   was routed to.

5. **Two bindings outlived release.** The coordinator's in-memory map treated itself as
   authoritative about whether a workspace was released, so a workspace released by anyone
   else left a stale binding that refused the successor with WORKFLOW_COLLISION against a
   workspace that no longer existed. The durable row is now the truth and the map is a cache.
   Separately, the branch slug was per-task, so attempt 2 collided with attempt 1's surviving
   branch; attempts past the first now carry the attempt in their slug, and the first keeps
   its bare name so nothing already certified is renamed.

Every fix sits in the layer that owns the decision, and none weakens a guard: the collision
check, the capacity limit, the ready-status allow-list and the branch-per-attempt rule are all
still enforced.

## Two path defects found in the same runs

- A bare directory target compiled to `^docs$` — a FILE named `docs`, nothing inside it —
  while `docs/` expands to `docs/**`. The planner reproduces the target verbatim in
  `allowedFileScope`, so a directory target fenced the writer out of the place it was told to
  write. Directory targets now carry a trailing slash; file targets are untouched.
- The proposer named `icos/src/core/context/context-engine.ts` for a file that lives at
  `src/core/context/context-engine.ts`. An agent inspecting a checkout reports a plausible
  path as readily as a real one. A proposal whose target is not in the repository, or escapes
  its root, is now refused and retried.

## Consequences

- A prepared attempt is now executable work in its own right. Anything that prepares one —
  QC's CORRECT/RETRY, the self-development repair loop, recovery — reaches the governed path.
- `workspaceSlug` takes an attempt number. Callers that omit it get the previous name.

## Evidence

`core3-autonomous-orchestration.integration.test.ts` — a new proof drives attempt 1, refuses
it, settles it, and asserts the correction gets its OWN governed workspace and branch and runs
the CORRECTION's prompt. 10/10 CORE3 proofs pass.

`SELF_DEVELOPMENT_E2E` now passes TWICE in a row from a reset target, on a dedicated database,
with durable evidence records — the first time it has been repeatable.

Mutations verified (each restored afterwards):

| Mutation | Result |
|---|---|
| Supervisor ignores pending intents | the correction proof fails |
| An existing intent is re-routed | the correction proof fails |
| One slug for every attempt | the correction proof fails |
| The in-memory map decides whether a binding holds | the correction proof fails |
| The refused attempt is not settled | the coordinator's repair proof fails |
| A bare directory target is passed through | the objective proof fails |
| A target that is not in the repository is accepted | the proposer proof fails |

Gates: typecheck PASS, build PASS, `git diff --check` PASS, lint 0 errors / 289 warnings
(baseline), unit 1856 PASS, integration 456 PASS / 4 skipped (opt-in E2Es).

## Known limit

A plan with a DEPENDENCY still blocks: a read-only inspection task is executed but never
settled, so the writer depending on it never becomes ready. That is DEFECT 36, closed on
`feat/core3-defect36-dag-settlement` (unmerged here). `ICOS_SELF_BUILD_E2E` therefore passes
when ICOS's self-chosen improvement yields a single writer task and blocks when its plan has
an edge.
