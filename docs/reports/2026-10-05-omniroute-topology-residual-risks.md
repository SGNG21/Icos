# OmniRoute topology lane — residual risks, classification and future owners

- Date: 2026-10-05
- Lane: `feat/omniroute-topology-routing`
- Implementation commit: `6f07058` (decision 0071)
- Status of the engine: **CODE_READY = yes, LOAD_BEARING = no, LIVE_PROVEN = no**

**DESIGN ONLY.** Nothing in this document is implemented. No CORE3, Temporal, schema, mission
repository, WorkspaceManager, autonomous-plan, Product Layer or runtime-supervisor file is touched
by this lane, and none should be touched to act on this document until the lanes that own them
have landed.

Every claim below marked *verified* was checked against the tree at `6f07058` with the command or
file:line given. Claims not so marked are proposals.

This document covers the five residual risks the owner named. It does **not** cover the defects
found by the independent review of `6f07058` — those are in decision 0071, Amendment A, and were
fixed in the lane.

---

## A. No caller, no persistence

**Classification:** expected, not a defect. The lane was scoped to the engine.

*Verified:* `grep -rn "planInference" src/` returns the module and its test only — no production
call site, no persistence, no migration.

**Future owner:** central integration, **after the Temporal governed-writer lane lands**. The two
decisions that lane must make, which this lane deliberately did not:

1. **Who asks for a plan, and when.** The natural seam is the supervisor's first dispatch and QC's
   `routeRetry` — the two places that already call `CapabilityRouter.route` — because a plan's base
   is exactly the router's own `result.requirement`, which already carries the compute context. No
   new input is needed.
2. **Where a plan lives.** A plan is a decision about a mission task, and the ledger already has
   the column shape for exactly that: `dispatch_attempts.routing_decision` (migration 0048) holds
   a ROUTING_DECISION written in the attempt's own transaction and never updated. A plan is the
   same kind of fact, one level up — it is decided once, before the first attempt, and describes
   several. It therefore wants its own append-only row keyed by mission task, not a column on an
   attempt. Reusing `routing_decision` would conflate "why this worker, for this attempt" with
   "what shape was intended, for this task".

**Do not** wire this before the writer lane lands: the plan's consumer is the thing that takes the
execution lease, and that code is being changed concurrently.

---

## B. Empty price registry

**Classification:** correct fail-closed behaviour today; `moneyEnforced` is unusable until the
owner deposits prices. Decision 0067 removed the literal on purpose so that no price could be
hand-written from memory.

*Verified:* `ICOS_PRICE_REGISTRY` is `Object.freeze([])` (`src/core/pricing/registry.ts:113`) and
is the default argument of `planInference` (`src/core/workers/inference-plan.ts:636`). No real
model price exists anywhere in the repository.

### The minimal durable contract, in five parts

**B1. The record shape needs nothing added.** `PriceRecord` already requires provider, modelId,
currency, both micros-per-million rates, provenance, `effectiveAt` and `staleAfter`
(`registry.ts:77`). There is no representable undated price. This part is done.

**B2. The consumption seams already exist and need nothing added.** `PostgresSpendLedger` and
`InMemorySpendLedger` both take `options.priceTable`; `planInference` takes `prices`. Three
injection points, all already typed. This part is done.

**B3. What is missing is a DURABLE SOURCE that is not a code literal.** Minimum:

- a table (`model_prices`) whose columns are exactly `PriceRecord`'s, with integer micros columns
  — never a float, per 0067 §4;
- `UNIQUE (provider, model_id, effective_at)`, so a correction is a new dated row rather than an
  in-place edit, and the history stays auditable;
- **no application upsert path.** Rows enter by migration, or by an owner-authenticated admin
  action that writes an audit entry. An agent must not be able to write a price it will later be
  budgeted against.
- the inserting migration's header carries the evidence (invoice id, or pricing-page URL plus the
  date it was read), matching the repository's existing migration-header convention. A
  `provenance` string of "de mémoire" is the one value that must never appear.

**B4. A LOADER, and one non-obvious constraint it must satisfy.**

*Verified defect in the current authority:* `ambiguousModelIds` (`registry.ts:160`) is
**date-blind**. It flags a model as `AMBIGUOUS` whenever two records share a `modelId`, regardless
of their date windows — and `resolvePrice` checks ambiguity *before* it checks `effectiveAt` /
`staleAfter` (`registry.ts:193-196`). So a table that keeps price HISTORY (which B3's unique
constraint deliberately encourages) would make every model with a superseded price permanently
`UNKNOWN_PRICE`.

Two ways to resolve it; the first is strictly smaller and is the recommendation:

- **(recommended) The loader selects one currently-effective row per model** before building the
  `PriceRegistry` — `WHERE effective_at <= now AND stale_after > now`, and if that still yields two
  rows for one model, pass both so `AMBIGUOUS` fires correctly, because two *simultaneously valid*
  competing prices genuinely are ambiguous. The pure authority stays untouched.
- (larger) Make `resolvePrice` date-aware before the ambiguity check. This changes the semantics of
  a module another lane certified, and would need its own decision.

The loader must also **fail closed**: any read error yields an EMPTY registry, so money refuses.
It must not serve a last-known-good cache, because a cache's freshness is a second clock and
`staleAfter` exists precisely so there is only one.

**B5. One unit assumption must be settled by the owner, not by code.** `goals.budget` is a
nullable `doublePrecision` with **no declared unit**; `GOAL_BUDGET_UNITS_PER_EUR = 1`
(`src/server/budget/goal-budget-cap-resolver.ts:50`) is a named, single-source *assumption*, not a
fact. A plan's `moneyMicros` derived from that column inherits the assumption. Either the owner
confirms the unit, or the plan's money ceiling comes from an explicitly-united source.

**Future owner:** the budget/pricing lane (the one that produced 0067), plus one owner decision on
B5. Until B1–B5 hold, callers must leave `moneyEnforced` unset; a **token-only** ceiling is fully
usable against an empty registry today and 0067 already proves it.

---

## C. Cold latency fleet

**Classification:** honest behaviour, but it is a deadlock in the enforced mode.

*Verified:* a candidate's latency is `history.meanDurationMs`, aggregated from terminal attempts in
the 14-day window (`compute-routing.ts`, `aggregateHistory`). A fleet with no terminal attempts has
no measured duration for anyone, so `latencyEnforced: true` refuses every candidate and the plan
is `NO_VIABLE_ROUTE`. Enforcement therefore blocks exactly the runs that would produce the
measurements it needs — it can never bootstrap itself.

**Rejected: a latency prior.** The repository already uses documented Bayesian priors for
reliability and quality (`HISTORY_POLICY`, prior 0.8 / 0.5), and reaching for the same trick here
looks consistent but is not. A rate prior is a probability in a bounded `[0, 1]` space where a
stated neutral value is defensible and where one real outcome moves it by at most `1/(n+K)`. A
duration prior is an invented number of milliseconds, in an unbounded space, with no neutral
value, **compared against a hard ceiling**. It would be a fabricated measurement deciding a
refusal. This is the thing the lane must not do.

**Proposed: a declared bootstrap admission, following the precedent that already exists.**
`rankComputePool` already has the right pattern for "a preference was relaxed because nothing else
qualified, and it is recorded, never silent": `fallback: "TIER_FALLBACK"`
(`worker-eligibility.ts`). Mirror it.

- Add `LATENCY_BOOTSTRAP` as a second `fallback` value on a planned candidate.
- It fires **only** when `latencyEnforced` is set and **no** candidate in the stage has a measured
  duration — a fleet-wide cold start. It never rescues a candidate that is measurably too slow, and
  never fires while any measured candidate exists.
- `meanDurationMs` stays **absent**. Nothing is invented; only the admission is recorded.
- The marking is on the plan, so its consumer may refuse to execute a bootstrap plan. The plan
  states what happened; it does not decide whether that is acceptable.

**A better long-term source, which does not exist yet.** The honest bootstrap signal is a *real*
measurement of a *different* call: the health probe's round-trip time. ICOS probes every candidate
on a 120 s horizon, so a probe latency would be fresh and never cold.

*Verified:* `WorkerHealthProber` does **not** time its probes — there is no duration, elapsed or
latency measurement in `src/server/services/worker-registry/worker-health-prober.ts`. So this is
not available today; it is a one-field addition in the prober's lane.

If it is added, it must be carried as a separately named field (`probeLatencyMs`) with its source
stated, and must **never** be written into `meanDurationMs`: a 400 ms probe answer and a 20-minute
task execution are not the same quantity, and collapsing them would be the same fabrication as a
prior, one layer down.

**Future owner:** this lane for `LATENCY_BOOTSTRAP` (strictly internal, no cross-lane conflict) —
but only once a caller exists, because an unwired engine cannot demonstrate a bootstrap. The
prober lane for `probeLatencyMs`.

---

## D. Unbounded total plan wall clock

**Classification:** real gap. Each stage's budget is bounded by the router's lease gate
(`budget + SETTLEMENT_MARGIN_MS <= lease`, decision 0054 §8), but the **sum** across a multi-stage
cascade is not, and no lease spans a plan.

### The bug this design must not reproduce

`AutonomousMissionRunner` checked `now - startedAt >= maxRuntimeMs` at the **top** of its loop,
and the only mission-settlement code in the system lived at the **end** of `SupervisorService.run()`.
Once a runtime passed its budget, every later wake-up returned at the guard and settlement became
unreachable: five live missions sat at `draft` with all tasks terminal, one for 16 days, each
holding workforce assignments, until Chief had no capacity left to delegate. Fixed 2026-10-05
(`8261a08`): `settleIfComplete()` is asked **first**, before any budget.

The lesson is not "be careful with deadlines". It is: **"am I out of time?" and "am I already
finished?" are different questions, and the cheap read-only one must come first.** A budget may
bound NEW work and nothing else.

### Design

1. **The plan carries an absolute instant, not a duration.** `deadlineAt` (ISO), computed at
   planning time. Absolute, because a duration obliges the executor to remember a start — and a
   remembered, never-reset `startedAt` is the exact shape of the bug above.

2. **It is derived from the ceilings, or it does not exist.**
   `deadlineAt = plannedAt + Σ over stages (stage.budgetMs + SETTLEMENT_MARGIN_MS)`, and **only**
   when every stage has a `budgetMs`. If any stage's budget is unknown, the plan carries **no**
   deadline rather than a guessed one — the same rule the module already applies to unknown tier,
   unknown latency and unknown price. A fabricated deadline is worse than none, because it would
   terminate real work.

3. **It gates two things and nothing else:** advancing to a **new stage**, and starting a **new
   candidate attempt** within a stage. It must never gate finishing, settling, reviewing,
   recording telemetry, releasing a reservation, or any read. Enforcement belongs to whoever holds
   the execution lease; this module stays pure and holds no clock.

4. **Reaching it is a normal termination, not an abort.** `PLAN_DEADLINE_REACHED` joins
   `TERMINATION_CONDITIONS` beside `CEILING_REACHED`. A terminated plan still settles — that is
   the whole point. Termination is a reason the plan ends, never a reason settlement is skipped.

5. **The order of checks is part of the design, not an implementation detail.** The consumer must
   ask, in this order: (a) is this plan already finished? → settle; (b) is the current stage still
   running? → leave it; (c) only then: is the deadline passed? → terminate **and settle**. Copy the
   shape of `8261a08`.

6. **The anti-regression proof the future lane must carry**, because it is the one that would have
   caught the original bug: *a plan whose `deadlineAt` has passed while its final stage has already
   completed must still settle.* The proof is about what runs AFTER the guard, not about the guard.

**Future owner:** this lane may add the `deadlineAt` field and its derivation (pure, internal, no
cross-lane conflict). **Enforcement is the writer/supervisor lane's**, and the ordering rule and
proof in (5) and (6) belong with it. Field and enforcement should not land in the same commit:
a field nobody reads is harmless, a half-enforced deadline is not.

---

## E. CLI worker cost not metered

**Classification:** real gap, and **smaller than previously stated**. The earlier residual-risk
note said worker cost "cannot" be metered. That was true of the OmniRoute HTTP seam but
understated what already exists: the readers are built, and the conversion to the canonical
vocabulary is built. Only the wiring is missing.

*Verified, in three parts:*

1. **The readers exist and are honest.** `src/server/workers/execution/worker-usage.ts` reads
   Hermes' `--usage-file` (input/output/total/model) and parses Codex's `tokens used N`, returning
   `UNMEASURED` with a reason rather than zero when the number is absent. Codex reports one total
   only, and the module refuses to split it.
2. **The conversion to the canonical vocabulary exists:** `toUsageOutcome(reading)`
   (`src/core/budget/worker-budget.ts:132`) maps a `WorkerUsageReading` onto the `UsageOutcome`
   that `SpendLedgerPort.record()` already accepts.
3. **Nothing calls it.** `grep -rn "toUsageOutcome" src/` matches the definition and its own test
   and nothing else. Likewise `readHermesUsage` / `readCodexUsage` have no production caller.

*And a second reader of the same fact already exists, in a no-go file:*
`src/server/execution/temporal/activities.ts:233-236` reads `usage.json` with its own inline
`JSON.parse` and hands it to `classifyHermesRun` — which uses it for the model and the result
block. **The token counts are discarded**: the activity returns `{ result, actualExecutor,
actualModel }` and no usage. So the measurement is taken and thrown away at the one place it is
already available.

### Design

**E1. One reader, not two.** The Temporal activity should call the canonical
`readWorkerUsage` / `readHermesUsage` instead of its own `JSON.parse`, for the same reason there is
one eligibility matcher: two readers of one fact give two answers, and the ad-hoc one has no
`UNMEASURED` vocabulary.

**E2. Carry the reading out of the activity.** `HermesExecution` gains a `usage:
WorkerUsageReading` field. `execution-record.ts:79` **already** declares
`readonly usage: WorkerUsageReading`, so the destination contract exists — the value simply never
arrives.

**E3. Record it where the attempt settles, not where it runs.** The settling transaction already
writes the terminal attempt; `ledger.record({ modelId, usage: toUsageOutcome(reading), attribution,
at })` belongs beside it, under the goal's existing attribution scope. Two properties follow for
free from code that already exists:
- an `UNMEASURED` reading becomes an `UNMETERED` ledger line — visible, never whitened to zero
  (`spend_ledger`'s CHECK constraint already enforces `UNPRICED ⇒ amount IS NULL AND
  unpriced_reason IS NOT NULL`, migration 0055);
- an unpriced model stays unpriced, so the money ceiling keeps failing closed rather than being
  satisfied by a worker whose cost is unknown.

**E4. What this does NOT give, stated plainly.** Recording is **not** bounding. A subprocess bills
its own provider account and crosses no ICOS seam, so no reservation can refuse it *before* it
spends. The existing substitute budget (`WorkerProxyBudget` — invocations, wall clock, max output,
`decideWorkerDispatch`) is what bounds launches, and `worker-budget.ts` already names it as a
substitute rather than a measurement. After E1–E3, ICOS would know what workers cost *after the
fact*; bounding it beforehand still requires either per-command limits or routing workers through
the gateway, and that remains an owner-level architecture decision.

**Future owner:** the Temporal / worker-execution lane for E1–E2 (both are in no-go files for this
lane), and the budget lane for E3. **Not this lane** — bolting worker accounting onto a routing
module would be exactly the cross-lane debt this freeze exists to avoid.

---

## Second falsifier (defaults and edge cases) — lane freeze

Run against `3ca0504`, narrow scope: request defaults and ceiling edge values. Six probes; two
findings, both internal to this lane and fixed in the lane, each with a regression test
(`inference plan — second falsifier: defaults and edge cases`).

1. **Independence default keyed on the topology name, not on the shape.** `mission-specific`
   with a `review` stage and `ensemble`'s `aggregate` stage (documented as "independent")
   defaulted to `independence: "preferred"`; measured, `oc/nemotron-3-ultra-free` was seated to
   judge work whose writer candidates included `nvidia/nemotron-3-ultra-550b`. Fix: the default is
   `required` whenever the plan has any judging stage. A caller may still pass `preferred`.
2. **A fractional token ceiling disarmed a money ceiling.** `tokens: 1000.5` made the worst-case
   cost `NOT_REPRESENTABLE` for a candidate whose price IS known, so `moneyMicros: 10` admitted a
   ~3 000-micro worst case. Fix: a token ceiling is floored to a whole count (narrowing only);
   below one token it is no ceiling.

Probes that held: an unreadable clock with money enforced refuses (`UNUSABLE_CLOCK`); an ensemble
with `diversity: "none"` over two routes to one model cannot seat an aggregator and refuses;
repeated writer stages in `mission-specific` are coherent.

Noted, not changed: a known price whose worst case overflows a safe integer is "unprovable", so it
is gated only under `moneyEnforced` — consistent with the documented "a money ceiling without
enforcement is a preference". Both lane files were already non-conformant to Prettier before
this pass; reformatting them is left out of the freeze to keep the diff reviewable.

---

## Summary

| # | Risk | Classification | Future owner | Blocks `moneyEnforced`? |
|---|------|----------------|--------------|--------------------------|
| A | No caller, no persistence | Expected, by scope | Central integration, after the writer lane | no |
| B | Empty price registry | Correct fail-closed | Budget/pricing lane + one owner unit decision | **yes** |
| C | Cold latency fleet | Honest, but deadlocked when enforced | This lane (marking) + prober lane (`probeLatencyMs`) | no |
| D | Unbounded plan wall clock | Real gap | This lane (field) + writer lane (enforcement) | no |
| E | CLI worker cost unmetered | Real gap, narrower than stated | Temporal lane (E1–E2) + budget lane (E3) | no |

Two defects in code this lane does not own were found while writing this and are **not** fixed
here: `ambiguousModelIds` is date-blind (B4), and the Temporal activity discards a measurement it
already reads (E).
