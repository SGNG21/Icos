# 0048: ICOS decides what to improve, and writes down what it did

## Status
Accepted

## Context

0047 left `SELF_DEVELOPMENT_E2E` passing from an ImprovementCandidate. Two things were still
missing before "self-building" could mean anything.

The first is that somebody else always wrote the candidate. Nothing in ICOS produced one, so
`advance()` on an empty backlog could only answer NO_CANDIDATE. ICOS could execute an
improvement; it could not decide on one. That is the whole difference.

The second is that the proof of a run existed only in a console that scrolled away and a test
database the next run truncated. Git kept the integrated commit; the goal, plan, workspace,
worker, reviewer verdict, gate result and learning were gone within minutes. "Completion
requires evidence" cannot mean evidence that existed only while someone was watching.

## DEFECT 38 — nothing proposed an improvement

`CanonicalImprovementProposer` turns a high-level instruction into ONE durable
`ImprovementCandidate`, built by the canonical factory, in `proposed` status, in the same
durable backlog the chain already selects from. Nothing downstream changes: the
self-modification policy, planning, routing, governance, review and the gate judge a proposal
exactly as they judge a human's.

One candidate, not a list: the coordinator advances one at a time, so a batch would either
strand most of it or put several self-development missions in flight at once. Idempotent by
construction, because the candidate's id is a content hash.

IT PROPOSES; IT DECIDES NOTHING. That is why a proposer may read the repository while a
reviewer may not (0047): a proposal is a suggestion everything downstream verifies, and a
review IS the verification.

Two runs taught it its own constraints, and both fixes are in the prompt, not the policy:

- ICOS proposed a genuinely good change — implement compaction in `ContextEngine.compact` —
  under category `reliability`, and its own fail-closed self-modification policy refused it.
  The policy was right: `reliability` is deliberately absent from `BACKLOG_CATEGORY_DOMAINS`
  (0046) because reliability work reaches core authority. The proposer is now told which
  categories it may propose, READ FROM the policy rather than restated. Governance is
  unchanged; a cycle is no longer spent producing something that will always be refused.
- An agent running inside a repository reports absolute paths. The canonical factory refuses
  them, correctly. That refusal is now treated as a shape failure and retried, and the prompt
  asks for repository-relative paths.

## DEFECT 37 — the fence was stated without its price

0047 taught the writer to commit. The contract listed its allowed paths and never said what
happens otherwise, so an agent wrote a good document one directory too high and the gate
rejected the ENTIRE run — correctly, and after paying for the work. The contract now says
that a file outside the scope rejects the whole run, including the part that was right.

## DEFECT 39 — the evidence was ephemeral, and in the wrong database

Two fixes, both in the runs themselves:

- A DEDICATED database (`ICOS_SELF_BUILD_DATABASE_URL`). These runs TRUNCATE, and the shared
  `icos_test` is where every other integration suite lives: a self-build run must not erase
  their rows, and the next suite must not erase the lineage this run is evidence for.
- `writeSelfDevelopmentEvidence` writes a record under `audit/self-build-bootstrap/evidence/`
  from DURABLE ROWS — candidate, goal, mission, plan id/version/fingerprint, DAG, dispatch
  attempts with routing/worker identity/lease, governed workspaces, execution results,
  the independent review with reviewer identity and reasons, the configured gate commands,
  the integration before/after, and the learned patterns.

  It is written BEFORE the assertions, so a run that stops early — the run whose lineage
  someone actually needs — leaves a record too. Where a row is absent the record says
  **ABSENT** on that line rather than omitting it, because a missing stage is precisely what
  a reader must see.

## One trap worth recording

The gate runs the repository's REAL `pnpm run test:integration` inside the governed
workspace. A gate command is a child process and inherits the environment, so
`ICOS_SELF_DEV_E2E=1` reached that nested run and it RE-ENTERED this very test, recursively,
inside the workspace it was gating — where it failed and rejected the run it was part of.

The fixture now strips its own opt-in flags from the gate commands. That is the fixture's
business, not the gate's: the gate is right to run the repository's real commands unmodified.

## Consequences

- `composeAutonomyRuntime` returns `improvementProposer`, absent when no proposer compute is
  configured. Absent means ICOS cannot start from an instruction; it never means "invent
  something".
- The proposer's compute runs with `cwd` set to `ICOS_REPO_PATH`, so it reads the repository
  it is proposing about. `CommandPlannerProvider` gained an optional `cwd` for this.
- Evidence records accumulate under `audit/self-build-bootstrap/evidence/`, one per run.

## Evidence

`ICOS_SELF_BUILD_E2E` — the only input is the sentence "Improve ICOS autonomously." No
candidate, goal, mission, task, plan, worker, review, approval or integration call is
supplied. ICOS proposed replacing a `z.any()` with `taskExecutionResultSchema` in
`src/core/context/contracts.ts`, planned it, allocated a governed workspace, wrote and
committed it, had it reviewed by a worker provably not the producer, ran the repository's own
gates against it — install, typecheck, lint, unit, integration, build — and advanced
`integration/phase-7` by exactly one commit, verified by git ancestry.

Unit: 8 proofs of the proposer (durable candidate in the canonical vocabulary; idempotent;
never resets in-flight work; fails closed on a foreign vocabulary after a bounded retry;
retries narration and a factory refusal; refuses an empty instruction; states the categories
its own policy allows). Plus the contract's fence-consequence proof.
