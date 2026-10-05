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
