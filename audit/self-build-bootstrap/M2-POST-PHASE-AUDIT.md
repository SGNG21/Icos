# M2 Post-Phase Audit

Date: 2026-09-27
HEAD: 71ee3aaa29d06dce305ea838fecefef104c9905f
Scope: CORE3 M2 — canonical AutonomousPlan/DAG contract + task planning metadata

## Findings

### MUST_NOW
**NONE.**

No finding blocks M2 certification. The items below are downstream milestones or
pre-existing debt, not M2 defects.

### SHOULD_NEXT

**S1 — Persisted planning metadata is not yet HONORED by the execution path.**
M2 makes the envelope canonical and durable. It does not make it effective.
Verified by grep that no consumer reads it:
- `attemptBudget` — nothing bounds retries by the task's own budget. Retry
  limiting today lives in the dispatch-attempt ledger, independently.
- `reviewPolicy` — nothing branches on it; review/QC runs by its existing rules,
  so `never` and `always` are currently indistinguishable at runtime.
- `requiredCapabilities` — not fed into worker selection.
  `reviewer-independence.ts` has its OWN `requiredCapabilities` for reviewer
  choice; the task's persisted list is not connected to it.
- Worker prompt is still `task.description || task.title`
  (`supervisor-service.ts:148`), ignoring the now-persisted `objective`,
  `instructions`, `successCriteria` and `allowedFileScope`.

This is honest scope, not an oversight: M4 owns capability routing, M5 owns
multi-worker execution, and bounded repair owns the budget. Recording it so M2 is
never mistaken for "the envelope is enforced". **Claiming CAPABILITY_ROUTING or
BOUNDED_REPAIR proven on the strength of M2 would be overclaiming.**

**S2 — The task DAG has two representations.**
`mission_tasks.depends_on` holds the real edges and drives readiness.
`tasks.dependencies` is persisted but every writer passes `[]`, so the canonical
Task's own dependency list is permanently empty. Mission N13 requires readiness
to derive from canonical dependency completion, so M3 must decide which is
authoritative and stop writing the other, rather than leaving a second, empty,
apparently-authoritative edge list. Duplicate authority (mission N2).

**S3 — Dead duplicate repository (carried from M1).**
`src/server/mission/postgres-mission-repository.ts` has zero importers and never
touches `autonomous_plans`. Still not removed: unreferenced, so it cannot affect
runtime, and deleting it deserves its own reversible commit + ADR.

**S4 — CERT-1 / CERT-2 still unrun (carried from M1).**
11 capability tests and 3 audit append-only tests remain skipped for lack of a
Docker daemon. CERT-1 blocks CAPABILITY_ROUTING in M4; CERT-2 blocks any claim
that evidence is tamper-proof. Cheapest fix: start Docker, re-run.

**S5 — Two canonical-JSON implementations.**
`fingerprintMissionPlan`'s `canonicalize()` (mission-plan.ts) and
`SchedulerService`'s private `canonical()` (scheduler-service.ts) solve the same
problem. Consolidate when one of them next needs a change; not worth churn now.

### LATER

**L1 — `format:check` fails on 243 files.** Repo was never prettier-formatted.
Needs its own decision; `--write` would rewrite nearly everything.

**L2 — drizzle-kit meta snapshots stop at 0009.** Migrations are hand-written and
journal entries appended manually, so `drizzle-kit generate` is unusable. 0041
followed the established hand-written convention.

**L3 — Empty migration file `0039_task_core3_fields.sql`.** 0 bytes, already
recorded as applied, so it cannot be edited. 0041 supersedes it. Leaving the
empty file is correct; removing it would break the applied-migration ledger.

**L4 — Mixed column naming.** `goals` / `goal_previews` use quoted camelCase
(`"goalId"`) from drizzle-kit-generated 0033; everything else is snake_case.

**L5 — `tasks` row is getting wide.** 22 columns, 5 of them jsonb. Fine at
current scale; revisit only if task listing shows up in profiling.

### REJECT

**R1 — Backfilling `tasks.dependencies` from `mission_tasks.depends_on`.**
Rejected: it would entrench the duplicate representation S2 identifies instead of
resolving it. Decide authority in M3 first.

**R2 — Making `riskClass` default to `read_only` instead of `reversible`.**
Safer on paper, but it silently changes the envelope of every existing task and
every legacy planner's output. The defaults deliberately preserve the previously
hardcoded behavior so M2 changes nothing for an existing planner. Revisit only as
an explicit, tested policy change.

**R3 — Duplicating the semantic envelope rules into the planner's zod schema.**
Rejected: `validateMissionPlan` is the single semantic gate. The planner schema
checks shape only (enum membership, integer ranges); cross-field rules such as
"a sensitive task may not be unreviewed" live in one validator, proven by the
planner test that supplies schema-valid-but-unsafe output and expects rejection.

## Dimension review

| Dimension | Assessment |
|---|---|
| Architecture | Improved. One validator (extended in place), one defaults resolver, one fingerprint authority. S2 is the remaining duplicate-authority debt. |
| Security | Improved. Risk class and review policy now fail closed at BOTH the validator and the DB CHECK, so a caller bypassing the planning layer cannot persist an unrecognized safety envelope. A sensitive task cannot be declared unreviewed. |
| Persistence | Substantially improved. The planning envelope was previously computed then dropped; it is now durable and proven to survive a full container restart. |
| Concurrency | `planExecutionOrder` levels give the first explicit, tested statement of what may run in parallel. Not yet consumed by a scheduler — M5. |
| Resilience | Metadata survives restart and replan; historical tasks keep their own envelope and planId (mission N10). |
| Provider replaceability | Improved. The envelope is requested in the prompt and parsed from provider output, with the semantic gate on our side, so a weaker provider is rejected rather than trusted. No provider is hardwired. |
| Test quality | Good. Two mutations were run against the central M2 claims (drop metadata in `taskToRow`: 5/7 fail; restore hardcoded envelope: 3/7 fail). Green is verified, not assumed. |
| Observability | Unchanged. Worth noting the envelope is now queryable (`tasks_mission_id_idx`, `tasks_plan_id_idx`), which future observability can use. |
| Cost | No new provider calls. The prompt grew by ~8 lines of schema guidance — negligible, and it buys planner-declared risk. |
| Technical debt | Net reduced: three silent data-loss boundaries closed, four hardcoded call sites collapsed into one resolver. New debt is recorded as S1/S2. |
| Unnecessary abstractions | None added. `planExecutionOrder` is new because no topological helper existed; the five pre-existing DAG rejections were reused, not reimplemented. |
| Autonomy opportunity | The planner can now declare its own risk, review policy and attempt budget — a prerequisite for ICOS deciding how its own work should be governed, rather than inheriting one hardcoded envelope.

## Verdict

MUST_NOW: NONE.
M2_CANONICAL_PLAN_CONTRACT_CERTIFIED

Proceeding to M3 (durable dependency/readiness engine), which must resolve S2.
