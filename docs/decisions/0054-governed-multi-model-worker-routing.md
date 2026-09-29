# 0054: Governed multi-model worker routing

## Status
Accepted

## Context

Five real self-build runs: orchestration safety PASS, completion FAIL. Run 5 had two legitimate
reviewer rejections and then two 20-minute worker budget timeouts; across runs 1–5 there were 7
budget timeouts and 1 crash. The blocker is worker compute, not orchestration.

Forensic audit of the path `task → capabilities → worker → attempt → workspace → execution →
result → review → correction → gate → apply → settlement` found:

- **ICOS never chose a model.** A worker is launched by a per-RUNTIME command
  (`ICOS_WORKER_EXEC_COMMANDS`); every worker on a runtime ran the CLI's default model.
  `metadata.model` / `metadata.provider` on a registration were labels (`identityOf`), never
  inputs. The self-build fleet was two workers labelled `writer-model` / `reviewer-model` running
  the same default model.
- **One router exists and is the authority**: `CapabilityRouter` over the pure canonical matcher
  `worker-eligibility.ts` (decisions 0031–0035): probe-dated health, availability, capacity and
  capacity pools, durable load from the ledger. It is called at the supervisor's first dispatch
  and at QC's retry/correction (`routeRetry`). Its ordering was "least load, then id".
- `AIResourceCatalog` / `AISelectionEngine` is a hardcoded fixture catalogue (gpt-4, claude-3…)
  not on the dispatch path. It is not the router and is not extended.
- **A timeout was recorded as `STREAM_FAILED`** — the class for a dropped transport. Run 5's two
  budget timeouts were indistinguishable from network drops, so nothing could route away.
- The reviewer backend was one fixed command / OmniRoute model; reviewer compute was not routed.
- The execution lease is not renewed while a worker runs; the container refused
  `timeoutMs >= lease` (685b4db) but left no settlement margin.

## Decision

1. **A compute candidate is a registered worker.** No second registry and no second router. A
   candidate's model, provider and family live in its registration metadata; its health is the
   prober's dated evidence; a provider account's quota is its `capacityPool`.
2. **The routed model is the model that runs.** `{{model}}` / `{{provider}}` placeholders in the
   worker exec, probe and reviewer commands. A template that needs a model refuses a worker that
   declares none (`MODEL_UNAVAILABLE`, nothing runs; the probe is unresolvable = dated failure;
   the reviewer `COMPUTE_UNROUTED` = no review = no integration).
3. **Policy lives in the canonical matcher** (`compute-routing.ts`, pure, `compute-routing/1`),
   applied only when a caller passes a compute requirement — with none, behaviour is exactly
   pre-0054. Gates: `BELOW_REQUIRED_TIER` (known tier more than one below need),
   `BUDGET_EXCEEDS_LEASE`, `PROVIDER_COOLDOWN` (rate limit 5 min and auth 30 min per provider,
   model-unavailable 10 min per model), `SAME_MODEL_AS_WRITER` (reviewer only, and only when a
   different model qualifies). Score = 0.30 taskFit + 0.25 reliability + 0.25 quality + 0.10 cost
   − 0.20 × (this model's failures on THIS task: infra failure 1, rejection 0.5, capped 2)
   − 0.05 × load. Ties: load, then id. Deterministic for fixed rows, clock and policy.
   Preferences never stall work: when nothing meets the required tier, the strongest candidates
   failing ONLY the tier gate are used and marked `TIER_FALLBACK`; a refusal caused only by
   cooldown or capacity is `transient` — the supervisor leaves the task ready (back-pressure),
   as QC already did, instead of blocking it.
4. **Family hints are priors, not rankings.** Six families (HAIKU 1, NEMOTRON_120B 2, SONNET 3,
   SOL 4, NEMOTRON_550B 4, OPUS 5; cost tiers alongside) recognised from provider model ids by
   pattern. Unknown family = unknown tier = neutral fit, never gated.
5. **Escalation is a function of ledger facts.** Required tier = complexity (from the canonical
   Task's `riskClass`) +1 at the 2nd legitimate rejection (+2 at the 3rd), +1 after a timeout /
   crash / stream failure; capped at 5. The planner states WHAT; the router decides WHO.
6. **History is derived from the ledger**, not a new table: terminal attempts naming a worker,
   joined to their independent review verdict, 14-day window, ≤ 50 per model, Bayesian-smoothed
   (K = 5; reliability prior 0.8, quality prior 0.5). One result moves a rate by ≤ 1/(n+5);
   cold start scores the prior. A verdict on a FAILED execution is not a quality signal.
7. **Failure taxonomy**: `EXECUTION_TIMEOUT`, `AUTH_FAILURE`, `MODEL_UNAVAILABLE` added (all
   retryable; business code UNKNOWN_EFFECT / WORKER_UNAVAILABLE). `normalizeFailure` maps the
   ledger + review + gate onto the owner's routing vocabulary; REQUEST_CHANGES is never
   infrastructure, a terminal worker verdict is TASK_LOGIC_FAILURE.
8. **One budget/lease invariant**: `budget + SETTLEMENT_MARGIN_MS (2 min) <= lease`. Enforced at
   boot (runtime timeouts), at routing (per candidate), and in the dispatcher before the lease is
   taken — after the lease, so the refusal (a terminal write) is fenced. A candidate may declare `executionBudgetMs` and `maxExecutionBudgetMs`; the larger is
   used only after an `EXECUTION_TIMEOUT` on the same task, still under the invariant. The
   selected budget and its reason are recorded.
9. **Evidence**: `dispatch_attempts.routing_decision` (migration 0048) holds the
   ROUTING_DECISION — policy version, requirement, required tier and escalation reasons, previous
   failure, every candidate with exclusions / score / history, selection, budget, lease — written
   in the transaction that creates the attempt and never updated. The reviewer's decision carries
   its own under `providerMetadata.routing`. `execution_duration_ms` records the process time.
   `selected.modelSteered` records whether the runtime's command actually passes `{{model}}`;
   when false, the recorded model is a label and the CLI's default ran.
10. **Independence, stated precisely.** The hard rule for a routed reviewer is
    `excludeWorkerIds` (the writer's own worker never reviews). Same-MODEL avoidance is a
    preference. The IntegrationGate's self-review check compares reviewer KIND with the writer's
    worker id and cannot fire for a routed reviewer; it was not relied upon and is not changed here.
11. **Unchanged**: attempt lineage (retries add rows; prepare below the newest attempt is
    refused), fencing (a terminal attempt cannot be leased), correction bounds, independent
    review, the IntegrationGate and its self-review refusal, apply-before-integrated (0053).

## Consequences

- The fleet comes from OmniRoute's `/v1/models` (`compute-fleet.ts`, deterministic worker ids,
  `auto/*` meta-routes skipped); `pnpm compute:snapshot` prints availability without secrets.
- Not measured yet: repository-gate pass rate and integration rate per model, token usage and
  cost (UNKNOWN; not fabricated). The gate outcome is not joined into history.
- History credits the registered model even for attempts on a non-steering runtime (the
  evidence says so via `modelSteered`); history is Postgres-only (in-memory starts cold) and is
  read with a 2 000-row cap inside the 14-day window.
- Reviewer runs are not charged to worker load or capacity pools.
- The legacy inline correction path (`record-mission-task-execution.ts`, `-correction-N`
  workflow ids, no worker id) is not routed; the external dispatcher refuses its attempts, as
  before 0054. Governed corrections go through QC.
- Reviewer routing requires a candidate declaring the `review` capability; with none, the
  configured reviewer reviews exactly as before.

## Rollback

Revert the code; migration 0048's rollback is in its header (map the three new classes back
first). Attempts routed under 0054 remain valid attempts.
