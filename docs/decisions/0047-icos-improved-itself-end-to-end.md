# 0047: ICOS improved itself end to end — and the four defects that stood in the way

## Status
Accepted

## Context

With defect 28 closed and the chain joined to its coordinator (0046), the self-development
cycle was driven against real compute until it either completed or stopped. It stopped eleven
times. Every stop was a different defect, every defect was invisible to reading, and each one
took exactly one real run to find.

This records the four that remained after 0046, because their shape is the point: each was a
component behaving correctly in isolation while the composition produced nothing.

## DEFECT 33 — nobody told the writer to commit

`composeWorkerPrompt` gave the worker its identity, objective, instructions, success criteria,
workspace path and a fenced file scope. It never asked it to COMMIT.

A real agent obligingly edited the file and stopped. `collectCommitEvidence` then reported
`commitHash: null` — correctly, from git, not from the worker's claim — the reviewer had
nothing to review and refused, and the gate had nothing to integrate. Every layer was right
and the run produced nothing, because the contract omitted the one act that makes work exist
outside a worktree.

A writer is now told to stage and commit in its workspace, on the branch already checked out
there, and that uncommitted work will be discarded. A reader is not told this, and must not
be.

## DEFECT 34 — the reviewer went and looked, in the wrong repository

A reviewer that is an agent CLI has a filesystem. `CommandReviewer` spawned it with no `cwd`,
so it inherited the server's working directory — the ICOS checkout, not the repository under
review — searched for the worker's file there, and returned:

> "The file docs/icos/worker-branch-lifecycle.md does not exist in the repository."
> "The commit hash a25c249… is not a valid object."

It was right about the directory it was standing in and wrong about the change. Two things
were missing, and both now hold:

- The canonical review policy says the reviewer judges ONLY from the context in its prompt,
  has no repository access, and must never treat what it cannot see as missing. This was
  implicit while the only reviewer was an HTTP model, which has no filesystem.
- `CommandReviewer` runs the agent in an EMPTY directory. Its verdict must depend on the
  review context and nothing else, and it has no business reading whatever the server happens
  to be sitting in.

## DEFECT 35 — the review context did not contain the change

With the reviewer correctly confined, it escalated instead — honestly:

> "Cannot verify the existence or content of the documentation file due to lack of repository
> access. Worker output is untrusted and cannot be relied upon per policy."

It was right again. The evidence carried a branch, a commit hash and a list of file NAMES. It
did not carry the diff. A reviewer asked to judge quality from file names can only escalate,
and a review of a change nobody can see is not a review.

`collectCommitEvidence` now captures `git diff base..HEAD`, bounded to 64 KiB, and the
dispatcher surfaces it as `change-diff` evidence. Truncation is RECORDED rather than silent,
so the reviewer knows whether it saw the whole change or part of it.

## Reviewer retry

The same measured variance the planner showed (0046): an agent answers a `.strict()` schema
correctly most of the time and not every time. `CommandReviewer` puts the same review to the
agent up to three times on a SHAPE failure only.

A verdict is never retried. `REQUEST_CHANGES` is an answer, not a malfunction, and asking
again until the reviewer says yes would not be a review — it would be shopping for one.

## Result

`SELF_DEVELOPMENT_E2E` PASSES, twice from a clean target, ~5 minutes per run:

```
ImprovementCandidate  (the only input: no missionId, taskId, plan, worker, review or approval)
  -> HighLevelGoal + Mission           SelfDevelopmentChain, canonical usecase
  -> AutonomousPlan + DAG              canonical planner, REAL local agent
  -> governed workspace + lease        default path, decided from riskClass + allowedFileScope
  -> external worker writes and COMMITS
  -> independent review                REAL reviewer, provably not the producer
  -> IntegrationGate + REAL gates      install, typecheck, lint, unit, integration, build
  -> integration/phase-7 advances      exactly once, by git ancestry
  -> durable learning
```

The integrated commit is real: `docs: add worker branch lifecycle documentation`, 11 lines,
written and committed by an autonomous worker, reviewed by an independent one, gated by the
repository's own gates, applied by compare-and-swap.

A run also found the last environmental truth: `BRANCH_CHECKED_OUT` — the integration target
must not be the branch checked out in the canonical repository, because advancing a ref that
a worktree has mounted would desynchronise it. The registry was right to refuse.

## Consequences

- `WorkerCommitEvidence` gains `diff` and `diffTruncated`. Anything persisting this evidence
  now stores up to 64 KiB more per attempt.
- A reviewer with tool access is treated as untrusted about its own context: confined to an
  empty directory and told, in the canonical policy, what it may rely on.

## Evidence

- `SELF_DEVELOPMENT_E2E_PASS` — 2 consecutive passes from a reset target, real planner, real
  worker, real reviewer, real repository gates.
- Unit: writer told to commit / reader not (defect 33); reviewer runs in an empty directory
  and the policy states it cannot see a repository (defect 34); evidence carries the diff and
  truncates it honestly (defect 35); retry proofs including "never retries a verdict".
- Gates: typecheck PASS, build PASS, `git diff --check` PASS, lint 0 errors / 289 warnings
  (baseline), unit 1843 PASS, integration 455 PASS / 3 skipped.
