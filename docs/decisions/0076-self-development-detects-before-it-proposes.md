# 0076: Self-development detects before it proposes — measured, metered, bounded

## Status

Accepted on `feat/p0au-w11-self-detection` (P0 autonomy unblock, worker W11, 2026-10-11).
Extends M14 (`CanonicalImprovementProposer`), 0052 (self-development is ordinary governed work)
and the spend seams of `budget/compose-spend.ts`.

## Context

The self-development loop (`DurableImprovementBacklog` -> `SelfDevelopmentChain` ->
`GovernedSelfDevelopmentCoordinator.advance()`, driven by `createSelfDevelopmentScheduler` when
`ICOS_SELF_DEVELOPMENT=enabled`) could select, plan, execute, review, gate and settle an
improvement. `CanonicalImprovementProposer` could turn an instruction into one candidate. But
nothing called the proposer, and its only provider was a planner COMMAND (unmetered). An empty
backlog therefore stayed empty: ICOS could not decide what to improve.

## Decision

1. **Detection is a measured, confined probe.** `EslintQualityProbe` runs the repository's own
   ESLint (`--format json`) through `runNonInteractive` under a required sandbox: repository
   read-only, network off, environment built (`envPassthrough: []`) with a disposable HOME, a
   killing timeout. Unconfined, truncated, timed-out or crashed runs are refused. Findings are
   aggregated by (file, rule) — counts, lines, the tool's message — never model text.
2. **Prioritization is deterministic**: the most frequent eligible finding, in the probe's order.
   A finding is ineligible when its earlier proposals/missions failed twice
   (`rejected` candidates + failed proposals) or when a settled mission already fixed it
   (`approved`/`implemented` candidate).
3. **The proposal is grounded and metered.** The proposer receives the findings plus "propose ONE
   fix for this finding, category maintainability, targetComponent = its file"; a proposal that
   names another file or category is a shape failure and never reaches the backlog. The evidence
   is appended to the rationale by code. With `ICOS_PLANNER_MODEL` (OmniRoute) the provider uses a
   NEW spend seam, `selfDevelopment`: attribution `self-development=sd-proposal-<UTC day>` (new
   `Attribution.selfDevelopmentProposalId`, last in `attributionKey` precedence), a daily token cap
   (`ICOS_SELF_DEVELOPMENT_PROPOSAL_MAX_TOTAL_TOKENS`, default 50 000), a reservation before every
   call. It can neither use nor drain a goal budget.
4. **It runs on the existing timer**, before `advance()`, under the same in-flight guard. No new
   loop, scheduler, registry or store.
5. **Bounds are durable** (context items, the store the backlog already uses): nothing while a
   candidate is in flight or selectable; at most `ICOS_SELF_DEVELOPMENT_MAX_PROPOSALS_PER_DAY`
   (default 1, 0 disables) attempts per UTC day, claimed as slot rows with deterministic ids
   (primary-key insert = cross-process claim). Detection evidence, slot and proposal outcome are
   recorded in partition `self-development-detection`; selection and policy verdict stay recorded
   on the candidate by the chain and coordinator.

## Consequences

- A candidate id remains a content hash; the evidence carries no timestamp, so an identical
  proposal is the same candidate and is reported `ALREADY_KNOWN`, not re-proposed.
- The planner-COMMAND proposer path is unchanged and remains unmetered.
- Audit events stay in durable memory rather than `audit_entries` (whose CHECK constraint would
  need a migration); upgrade path if operators need them in the audit view.
