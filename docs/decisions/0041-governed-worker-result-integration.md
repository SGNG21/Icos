# 0041: The gate decides, an applier acts — fast-forward by compare-and-swap

## Status
Accepted

## Context

`IntegrationGate` says so in its own header: *"Ne merge rien : ACCEPT signifie « prêt à
être intégré », l'intégration reste humaine/contrôlée."* That was right while a human
performed the merge.

It is not sufficient for autonomous self-development. Under M6.3/M7 an ACCEPTed result had
nothing happen to it at all: the branch simply accumulated. The CORE3 chaos certification
demonstrated the accumulation directly — a single task left **two** worker branches behind,
one per attempt, and nothing ever reaped or integrated either.

Worse, the reaping that did exist could never fire (below).

## Decision

### 1. Extend the canonical boundary; do not add a second merge path

`IntegrationApplier` lives in the workspace manager, uses the same `Git` port, the same
`WorkspaceManager`, the same lease and the same fencing token as the gate. There is no
other way to move the integration target.

The split is by responsibility, not by convenience: **the gate DECIDES, the applier ACTS,
and only on a decision the gate already granted.** `accepted` is reachable only through the
gate, so "worker output never self-merges" is a structural property — there is no state a
worker can put itself into that the applier will accept — rather than a convention.

### 2. Fast-forward only, by compare-and-swap

The target advances only when the accepted commit already contains it. `update-ref
<new> <expectedOld>` is an atomic CAS on the ref, and it was chosen over `git merge`
deliberately:

- **no merge commit is ever created by a machine**;
- **no conflict is ever resolved by a machine** — a diverged target returns `NEEDS_REBASE`,
  sending the work back through the gate where a human or agent resolves it;
- the target's history cannot be rewritten or lost;
- there is no read-then-write window, so two integrators racing cannot both win;
- it needs no checked-out tree.

`merge`, `rebase`, `reset`, `checkout`, `push` and `clean` remain forbidden in the `Git`
port. `update-ref` is the single added verb.

A branch that is **checked out** anywhere is refused: moving a ref under a live worktree
desynchronises its index from HEAD and silently makes every later `git status` there wrong.

### 3. Exactly-once is DERIVED, not counted

"Already integrated" is answered by asking git whether the accepted commit is an ancestor
of the target — not by a flag that could drift and not by a counter a crash could leave
wrong. A replay after a crash mid-integration therefore reaches the same answer as the run
that crashed, because the answer is a property of the repository. This is the same
principle as deriving worker load from the dispatch ledger (0034).

A lost CAS returns `RACE_LOST`, not an error: it is an expected outcome, and re-running
converges — the loser is genuinely diverged by then and correctly returns `NEEDS_REBASE`.

### 4. Reaping asked git the WRONG QUESTION, and so never fired

`WorkspaceManager.cleanup` used `git branch -d`, which checks a branch against **HEAD** and
its upstream — not against an arbitrary ref. A worker branch fast-forwarded into
`integration/phase-7` while the repository's HEAD sits on another branch is reported *"not
fully merged"* and kept. **Forever.** Verified empirically, not reasoned about.

`deleteBranchMergedInto(branch, target)` asks the question that matters: is every commit on
this branch already reachable from the ref we integrate into? If yes, the branch is a
pointer to commits that live on elsewhere and deleting it destroys nothing. If no — a
rejected result — it is the only copy and it is kept.

It deletes with `update-ref -d <ref> <oldValue>`, a compare-and-swap delete, which is safer
than `branch -D`. That bypasses the `FORBIDDEN_FLAGS` guard narrowly and deliberately: the
guard exists to stop a *caller* smuggling a destructive flag into an arbitrary command, the
argv here is built entirely inside the method from validated inputs, and the ancestry
precondition is strictly stronger than the one the blocked command would have applied
itself.

Evidence ordering is preserved: `cleanup` writes the workspace archive **before** removing
anything, and refuses outright to reap a worktree holding uncommitted work.

## Consequences

- An accepted worker result now reaches the canonical branch, exactly once, automatically.
- A rejected result keeps its branch, so nothing is ever destroyed unreviewed.
- Defect 19's two halves — integrate and reap — are both closed at the canonical boundary.
- Still open: the M6.3 executor provisions its OWN ad-hoc worktree
  (`writer-workspace.ts`) rather than a registered `Workspace`, so external worker output
  does not yet FLOW through this path automatically. That is the remaining connection, and
  it is recorded as a defect rather than hidden.

## Evidence

- 1780 unit tests (+13), all against REAL git via `makeRepoFixture`.
- 5 mutations verified: dropping the already-integrated check breaks exactly-once and
  crash-resume; allowing a non-accepted status breaks the self-merge refusals; dropping
  fast-forward-only breaks divergence handling; reaping against HEAD reintroduces the
  accumulation bug; deleting a branch not contained in the target destroys evidence.
- Proof markers: `EXACTLY_ONCE_WORKER_INTEGRATION_PROVEN`, `WORKER_WORKTREE_REAPING_PROVEN`.
- typecheck PASS, lint 0 errors / 289 warnings (= baseline), `git diff --check` PASS.
