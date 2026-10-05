# 0071: An inference plan is a governed topology over OmniRoute, not a second router

## Status
Accepted

## Context

Decision 0054 gave ICOS one compute routing authority: `CapabilityRouter` over the canonical
matcher `worker-eligibility.ts`, with the compute policy `compute-routing/1`. A compute candidate
is a registered worker; its model, provider and family are its registration metadata; its health
is the prober's dated evidence; its quota is its `capacityPool`. Every selection writes a
ROUTING_DECISION (migration 0048).

That authority answers one question: *which compute should do this task, now?* It answers it well.
What it cannot do is state a SHAPE in advance. Measured against the owner's target list:

- **Fallback was not a plan.** A failed attempt left the task ready; the next dispatch pass routed
  again and whatever it chose was the fallback. There was no record of an intended alternate and
  no declared bound on how many there were.
- **Cascade, critique and ensemble did not exist.** Reviewer routing existed (`role: "reviewer"`,
  `excludeWorkerIds`, `SAME_MODEL_AS_WRITER`) but only as a second independent call, not as a
  declared stage of one governed whole.
- **Three ceilings the owner's list names were not routing inputs at all.** A latency target: the
  ledger's `meanDurationMs` was aggregated and never gated on. A token ceiling: enforced at the
  HTTP seam (`request-bounds`, `metered-fetch`), never considered against a candidate's context
  window. A monetary ceiling: `core/pricing/registry` is the dated price authority and
  `core/budget` meters real spend, but neither was consulted when choosing compute.
- **`AIResourceCatalog` / `AISelectionEngine` remains a fixture catalogue off the dispatch path.**
  It is not the router, and is still not extended.

## Decision

1. **OmniRoute stays the only routing authority. There is no second router.** Every candidate a
   plan names comes out of `rankComputePool(pool, requirement)` — one call per stage, with that
   stage's role and its inherited hard exclusions. The new module can only ADD exclusions; it
   cannot promote a candidate the router refused.

2. **An `InferencePlan` is DATA, not an orchestrator.** `src/core/workers/inference-plan.ts` is
   pure (no I/O, no clock, no randomness; the clock arrives as `ComputeContext.now`, prices as a
   `PriceRegistry` argument) and serializable. A stage names a ROLE (`writer` | `reviewer` — the
   router's own two, no third role invented), a PURPOSE, its ordered candidates, its parallelism,
   its ceilings, the `AdvanceCondition`s that hand over, and every candidate it refused with why.
   Whoever executes a plan — CORE3's supervisor, QC, the reviewer service — keeps every authority
   it already has. **Brain != Worker != Model != Provider**: a stage names a worker, which carries
   a model and a provider. It never names a brain and never becomes one.

3. **Ten topologies, two primitives.** `single`, `fallback`, `cascade`, `critique`, `reviewer`,
   `ensemble`, `cheap-first-escalate`, `latency-first`, `quality-first`, `mission-specific` are
   stage counts and candidate orderings over a producing stage and an independent judging stage.
   `cascade` and `cheap-first-escalate` have **the fleet's stage count, not the plan's**: one stage
   per ascending group of the fact they escalate on (capability tier, cost tier) as that group
   exists among the ranked candidates. No requirement is fabricated to force an escalation, and an
   unknown tier gets its own last stage rather than being folded into a known one.

4. **Ceilings narrow, never widen.** `effectiveCeilings(governed, requested)` takes the MINIMUM of
   every numeric ceiling and the OR of every enforcement flag: a caller may tighten a ceiling and
   may turn fail-closed ON, never off. The Goal budget and the policy remain authoritative. The
   plan records the effective value AND which side it came from (`ceilingSources`), so "nothing was
   widened" is readable from the record rather than asserted.

5. **A privileged-provider bypass is unexpressible, not refused.** `InferencePlanRequest` has no
   provider and no model field; `mission-specific` declares roles and purposes only. There is no
   runtime check to forget.

6. **Unknown money fails CLOSED.** The worst case of a stage is its whole token ceiling billed at
   the completion rate (never below the prompt rate; the registry's integer-micros arithmetic
   already rounds a non-zero remainder up). With `moneyEnforced`, a candidate whose price is
   absent, ambiguous, invalid, not-yet-effective or STALE is refused — `COST_UNPROVABLE`, carrying
   the registry's own defect words — and money enforcement with **no token ceiling** refuses too,
   because an unbounded worst case is not a provable one. Without enforcement the cost is recorded
   as unknown with its reason. Never 0, never interpolated.

7. **Unknown latency stays unknown.** A measured mean duration above the ceiling is refused; an
   unmeasured one is NOT gated unless `latencyEnforced` is set, in which case it is. Same shape as
   decision 0054's unknown-tier rule.

8. **Independence is a declared level, not a fixed rule.** `required` (the default for `reviewer`
   and `critique`) makes a judge sharing the writer's effective model a REFUSAL —
   `NOT_INDEPENDENT_OF_WRITER`. `preferred` keeps decision 0054's behaviour, where the preference
   relaxes so work never stalls. The hard rule is unchanged and inherited: a judging stage's
   `excludedWorkerIds` contains every worker its producing stage could have used, enforced by the
   canonical matcher's existing `EXCLUDED_WORKER` gate. "Same judge" is `sameEffectiveModel` —
   decision 0054's one rule, not a new one.

9. **Diversity uses the same normalization as independence.** `diversity: "model"` keys on
   `effectiveModelKey`, so two routes to one model are one model (first measured as a defect:
   `anthropic/claude-sonnet-5` and `oc/claude-sonnet-5-high` were seating two "different" models).
   `"family"` keys on the recognised family and is the default for `ensemble`.

10. **No viable route is explicit and durable.** `NO_VIABLE_ROUTE` names the stage, its role and
    purpose, the reason, and every refusal. It carries `transient: true` only when every refusal
    ends by itself (`PROVIDER_COOLDOWN`, `AT_CAPACITY`, `CAPACITY_POOL_SATURATED` — decision 0054's
    own set), which the caller must treat as back-pressure.

11. **Telemetry is subordinate to serving, and this is now proven.** A plan states the evidence a
    run of it must produce (ROUTING_DECISION, token usage, cost-when-known, duration, and the
    condition that fired — all PER STAGE). The existing guarantee that measurement cannot corrupt a
    successful provider response (`observe` in `metered-fetch.ts`, written after a real reviewer
    failed as `PROVIDER_FAILURE` for exactly this) had no test; it has two now.

12. **Unchanged.** `compute-routing/1` and its gates, scores, history and cooldowns; the
    budget/lease invariant and `SETTLEMENT_MARGIN_MS` (the router holds the lease and keeps that
    gate — a second opinion from a module that does not hold it would be a second authority);
    CORE3 orchestration; the Temporal writer path; the runtime supervisor; the Product Layer; the
    IntegrationGate and its self-review refusal; migration 0048's evidence.

## Amendment A — independent review of `6f07058` (2026-10-05)

An independent adversarial reviewer, given no implementation context and told to falsify rather
than read, ran 46 probe assertions against the ten invariants. Six held; **four decisions above
were overstated and are corrected here.** Each correction is proven by a test that fails when the
fix is reverted (seven mutations attempted, seven caught).

**A1. §8 was false at the shipped defaults. Independence covered only the FIRST writer candidate.**
`writerModel ??= kept[0]?.candidate.model`, while a producing stage's default width is **2**.
Measured: writers `[nemotron-3-ultra-550b, oc/claude-sonnet-5-high]`, judge
`anthropic/claude-sonnet-5` — the same effective model as writer candidate #2 — seated, with
`independence: "required"` recorded on the plan. A judge must be independent of whatever actually
ran, and **any declared candidate may run**. The plan now collects every model every producing
stage declared and refuses a judge matching **any** of them.

Related, and also false: a writer declaring **no model** skipped the check entirely *and* left the
router's own gate off, so a plan recorded `independence: "required"` while nothing had been
verified and no refusal said so. An unprovable independence is now a named refusal,
`INDEPENDENCE_UNVERIFIABLE`. This is narrower than 0054's choice not to refuse on an unknown model:
0054 governs every dispatch, whereas here the **caller declared** the requirement, so failing
closed is honouring the declaration rather than imposing a new policy.

**A2. §4 was false for `NaN`.** `r >= g` evaluates to **false** for `NaN`, so `requested` won the
minimum and the effective ceiling became `NaN` — after which every later comparison
(`meanDurationMs > NaN`, `contextWindow < NaN`) is false, so the ceiling gated nothing, and it
serialized to `null`, i.e. "no ceiling at all" on reload. `0` and negatives were accepted as
narrowings too. A ceiling is now usable only if it is a **positive finite number**, on both sides,
and an unusable value is discarded rather than compared. Exactly the shape of `UNUSABLE_CLOCK` in
0067 §3, and found the same way.

**A3. §9 was false. `effectiveModelKey` is not the same-judge rule; `sameEffectiveModel` is.**
The latter is key-match **OR** family-match, and the pair `compute-routing.ts` names in its own
comment — `nvidia/nemotron-3-ultra-550b` and `oc/nemotron-3-ultra-free` — normalizes to two
different keys. Both were seated as "two models" while being one model under two routes, so an
ensemble could have had no diversity at all. The `"family"` value's fallback key used the **raw**
model id, compounding it.

Under the correct relation the two values are one value, so `diversity` is now
`"none" | "distinct-model"` with a single rule. Separately: a candidate already refused — by this
module or by the router — no longer **consumes a diversity seat**. Measured: an `unhealthy` route
sorted first under `latency-first`, took the seat, and the healthy route to the same model was
dropped as a duplicate, costing the stage its only viable member.

**A4. The plan was overruling the authority it claims to defer to.** `viable` tested
`exclusions.length === 0`, but `rankComputePool` expresses a TIER_FALLBACK by setting
`selectable: true` while **leaving** `BELOW_REQUIRED_TIER` in `exclusions` — the router saying
"nothing meets the tier, these are the strongest that remain, and it is recorded" (0054 §3,
*preferences never stall work*). So the plan returned a permanent `NO_VIABLE_ROUTE` where a bare
dispatch would have run, and dropped the relaxation's provenance. The router's own `selectable`
verdict is now what decides, and its `fallback` is carried as `routerFallback` on the candidate.
§1's claim holds only because of this change.

### Also corrected, less severely

- **§6's justification was unproven.** "The completion rate, which is never below the prompt rate"
  is enforced nowhere — `recordDefect` only requires both rates positive. A record with a prompt
  rate ten million times the completion rate validated, and a candidate was admitted under a
  5-micro enforced ceiling with a "worst case" of 1 micro. The worst case now charges every token
  at **whichever side bills more**, which needs no assumption. No change to the price authority.
- **`tokens` was documented as OUTPUT tokens and used as if it were TOTAL.** Two things were wrong
  at once: it was compared against a candidate's whole `contextWindow`, and the worst case charged
  **zero prompt tokens**, so a stage "proven" at 3 000 micros for 1 000 output tokens really cost
  103 000 with a 100 k prompt. `tokens` is now TOTAL tokens per stage.
- **The plan authored a retry budget it had no business authoring.** `maxAttemptsPerStage`
  defaulted to 2, was clamped by the *width* clamp (so retries silently capped at 8), and made
  `topology: "single"` — whose own text says a failure is the task's failure — ship two attempts
  over one candidate. Removed: a stage's `maxAttempts` is exactly its declared candidate count, and
  `RETRY_BUDGET_EXHAUSTED` is gone. How often to re-run the same compute belongs to the lease, the
  policy or QC.
- **`costUnprovableBecause` was attached to every refusal**, so a candidate excluded as the
  writer's own worker carried "no token ceiling" beside it — sending an operator to the price
  registry over a review-independence rule, the exact failure the field was added to prevent. It
  now appears only on a refusal the cost caused.
- **Every cascade stage after the first claimed zero refusals.** One ranking produces them all, so
  they belong to every stage of the cascade.
- **A `NO_VIABLE_ROUTE` carried neither the policy version nor the ceilings**, so a refusal could
  not be re-derived against the inputs that caused it — and the ceilings are exactly what a money
  or latency refusal turns on. §2's "a plan read back can be re-derived" did not hold for refusals.
- **An `ensemble` degraded silently to one member.** It now refuses below two distinct judges.
- **A `cascade` could advance on `REVIEW_REQUEST_CHANGES` while declaring no review outcome could
  terminate it.** `terminateWhen` now follows what the stages actually advance on.
- **`mission-specific` validated nothing** — any `(role, purpose)` pair, a judge before any
  producer. Both are refused.
- **Plans carried present-but-undefined keys**, so `toEqual` passed a JSON round trip while
  `toStrictEqual` threw — and the module's own round-trip test was written the weaker way. Every
  optional field is now omitted when absent.
- **§12 cited `SETTLEMENT_MARGIN_MS` as if the plan enforced it.** It was imported solely to be
  re-exported; no logic used it. The router holds the lease and keeps that gate, as §12 otherwise
  says. The vestigial re-export is gone.

### Tests the review found to be asserting nothing

`expect(JSON.parse(JSON.stringify(p))).toEqual(JSON.parse(JSON.stringify(p)))` compares two round
trips of the **same value** and passes for any object; the honest form, `toStrictEqual(round, p)`,
failed. "Same inputs, same plan" is near-tautological for a pure function with an injected clock,
and is now joined by a proof that spies on `Date.now`, `Math.random`, `setTimeout` and
`setInterval` across every topology and asserts none is touched. The structured-output test
asserted a label's presence without asserting the candidate was dropped. The test file's header
claimed "every proof goes through the REAL CapabilityRouter"; the router is used as a
`ComputeContext` factory, and the header now says so, with a dedicated property test that re-checks
every seated candidate against the authority across all topologies.

### Two findings deliberately NOT fixed here

- **`metered-fetch.ts:153` and `:169`** read `response.headers` and call `readUsage` **outside** any
  `try`, so a *throwing* `headers` getter — the exact shape the comment at `:148-150` describes
  from a real incident — still propagates to the caller, and `:151`'s "jamais une erreur" is
  overstated. The two tests added at `6f07058` cover an **absent** `get`, not a throwing one. That
  file is the production spend seam and belongs to the budget lane; changing it from a routing lane
  is the cross-lane debt this freeze exists to avoid. **Owner: budget lane.** Fix: move both reads
  inside the existing `try` and return `UNMETERED` on throw.
- **`registry.ts:143` does not require `completion >= prompt`.** Handled on this side by charging
  the dearer rate, so no change to a shared, separately certified authority is needed. If the
  owner wants the invariant stated, it needs its own decision.

Invariants the review confirmed unchanged: no second router (after A4), no health bypass across
4 topologies × 3 diversity settings × width 8, price fails closed on all five defect paths, no I/O,
no state, no timer, no clock, and the caller's body is never consumed by measurement.

## Consequences

- **Nothing is wired yet.** This lane adds the authority and its proofs; no caller builds a plan,
  and no plan is persisted. Wiring it (which stage of CORE3 asks for a plan, and where a plan is
  stored) is a separate, reviewable change.
- **Money enforcement refuses everything today**, because `ICOS_PRICE_REGISTRY` is empty by design
  (decision 0067). That is the correct fail-closed behaviour and it is what the proof asserts; it
  becomes useful the day the owner deposits dated prices. A caller must not set `moneyEnforced`
  until then.
- **Latency enforcement refuses a cold fleet**, for the same honest reason: a model with no
  terminal attempts in the 14-day window has no measured duration.
- A plan's total wall-clock time is not bounded. Each stage's budget is bounded by the router's
  lease gate; the SUM across a multi-stage cascade is not, and no lease spans a plan.
- `quality-first` orders on the router's smoothed review-quality rate alone, not the aggregate
  score, so a cheap fast poorly-reviewed model cannot win a quality-first stage on its cost
  component.

## Rollback

Delete `src/core/workers/inference-plan.ts` and its test. No migration, no schema, no call site.
The two tests added to `metered-fetch.test.ts` assert existing behaviour and should be kept.
