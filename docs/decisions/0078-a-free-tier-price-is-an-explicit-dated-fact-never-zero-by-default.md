# 0078: A free-tier price is an explicit dated fact, never zero by default

## Status

Proposed (FABLE 5.1 convergence, 2026-10-14). Document only: no source, no migration, no
registry entry is changed by this decision. Extends 0067 (pricing is a dated registry, money is
integer micros), 0071 §6 (unknown money fails closed in an inference plan), 0054/0071 (OmniRoute
is the only routing authority) and 0064 (the fleet is reconciled, never enabled). The number is
provisional; parallel lanes have collided on decision numbers before, so the integrator re-checks
it. Owner's instruction, verbatim:

> Conçois la prise en charge explicite d'un tarif à zéro pour les fournisseurs dont la gratuité
> effective, les quotas et les conditions d'utilisation sont vérifiés. Ne confonds jamais modèle
> inconnu, coût inconnu et coût réellement nul. Bloque le fallback de auto/best-free vers un
> modèle payant non autorisé, notamment Claude Opus 5.

## Context

Decision 0067 made a tariff a dated record or nothing, and made `UNKNOWN_PRICE` the same word as
`UNPRICED` so that one vocabulary circulates. It also refuses a zero rate on purpose:
`recordDefect` in `src/core/pricing/registry.ts` rejects `promptMicrosPerMillion` or
`completionMicrosPerMillion` when `value <= 0` (INVALID_ENTRY), because "a 0 is not a price: it is
a placeholder or a typo, and accepting it would make the model free for ever while counting it as
priced". That guard is right and stays.

Its side effect was measured on 2026-10-14 (`docs/icos/OMNIROUTE_MODEL_STRATEGY_2026-10-14.md`,
§5): a model that really is free — NVIDIA NIM `nvidia/nvidia/nemotron-3-ultra-550b-a55b`, which
answered the reviewer golden tasks 6/6 at zero charge — is **indistinguishable from a model whose
price nobody knows**. Both are `UNPRICED`. `spend_ledger` cannot say "0 EUR" for the first without
lying about the second, `pnpm mission:trace` prints the cost kind word for both, and the cockpit's
`costMetric` shows `UNPRICED n/m` for a mission that cost nothing. Three facts are being folded
into one word:

1. **unknown model** — the id is absent from the registry (`ABSENT`), or two entries compete
   (`AMBIGUOUS`);
2. **unknown cost** — the model is known but the price is not usable (`INVALID_ENTRY`,
   `NOT_YET_EFFECTIVE`, `STALE`, `UNPRICED_TOKENS`, `NOT_REPRESENTABLE`, `UNUSABLE_CLOCK`);
3. **a cost that is genuinely nil** — a provider whose free tier, quota and terms of use were
   verified on a stated date.

The third fact has no representation today, so the honest system prints "unknown" for it. The
tempting shortcut — admit a zero rate — would reintroduce the exact laundering 0067 closed: a
typed `0` is a typo until proven otherwise, and a free tier is a *term of use with an expiry*,
not a rate.

The same measurement produced a second finding. OmniRoute's `auto/*` combos are not models:
`auto/best-free` served **`claude-opus-5`** (41 prompt / 5 completion tokens), the dearest model
the gateway lists, under an alias whose name says "free"; `auto/coding:free` failed 502 through
Groq; `auto/claude-*` aliases were served by Gemini and Nemotron on 2026-10-12. A combo's served
model is not the requested model, and the fallback inside the combo is the gateway's, not ICOS's:
no ROUTING_DECISION records it, no allowlist checks it, no budget was told. `compute-fleet.ts`
already skips `auto/*` when it builds the fleet ("a candidate must be ONE model, or history and
independence would be attributed to whatever the meta-route picked that day"), but the three
operator variables that name a model directly — `ICOS_AUTONOMY_ALLOWED_MODELS`,
`ICOS_REVIEWER_MODEL`, `ICOS_PLANNER_MODEL` — accept any non-blank string (`src/config/env.ts`,
`modelAllowlist`/`frozenIds` in `src/core/autonomy/model-allowlist.ts`).

Measured provider states on 2026-10-14, from the same document, kept here because the decision
below relies on them:

| Provider / id                                       | Last dated probe                                   |
| --------------------------------------------------- | -------------------------------------------------- |
| `nvidia/nvidia/nemotron-3-super-120b-a12b`          | 200 in 1.0 s                                       |
| `nvidia/nvidia/nemotron-3-ultra-550b-a55b`          | 200 in 0.7 s; reviewer certification 6/6           |
| `nvidia/z-ai/glm-5.3`                               | 200 in 2.3 s; timeout on every reviewer task       |
| `nvidia/*` deepseek-v4.1-flash, kimi-k3             | timeout 45 s; several ids 404 (stale catalogue)    |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | 200 in 0.9 s                                       |
| `openrouter/*:free` (super, gemma-4-31b, north-mini, `openrouter/free`) | **502**, **429** (31 s), **502**, **502** |
| `groq/*` (gpt-oss-120b, gpt-oss-20b)                | **502** "upstream returned an empty response"      |
| `oc/*-free` (OpenCode)                              | **403** "free tier can only be used from within OpenCode" / 400 |
| `gemini/gemini-3.1-flash-lite`                      | 200 in 2.1 s; free tier not confirmed              |
| `gemini/gemini-3.5-flash`                           | **503** (35 s)                                     |
| `mistral/codestral-latest`                          | 200 in 0.3 s; free tier not confirmed              |
| `auto/best-free`                                    | 200, served `claude-opus-5`                        |

OmniRoute returns no quota header; a 429 surfaces as "Provider returned error" with a per-id
cooldown. The only place quotas can be read is the gateway dashboard, by the owner.

## Decision

### 1. A third cost outcome, `FREE_TIER`, exists and is produced only by a dated registry record

`FREE_TIER` is a **third word**, beside `COST` and `UNPRICED`. It is never a `COST` of amount 0
and never an `UNPRICED` with a friendlier reason. It can only be produced by a registry record of
a new shape:

- `PriceRecord` becomes a discriminated union. The existing shape carries `kind: "RATE"` and is
  otherwise unchanged — including the `value <= 0` refusal, which stays exactly as it is. The new
  arm is `FreeTierPriceRecord`:
  `{ kind: "FREE_TIER"; provider; modelId; currency; provenance; effectiveAt; staleAfter;
  verifiedQuota }`. It has **no rate fields at all**: there is no place in it to type a zero.
- `provenance` must name the terms or pricing page (a URL or document reference) **and** the date
  the verification was made; `verifiedQuota` is a non-empty note of the quota and conditions
  observed (credits, requests per minute, "development use only", account tier). A blank in either
  is `INVALID_ENTRY`.
- `staleAfter` is required and **short**: `recordDefect` refuses a `FREE_TIER` record whose
  horizon exceeds `FREE_TIER_MAX_FRESHNESS_DAYS = 30` after `effectiveAt`
  (defect `INVALID_ENTRY`, reason "free-tier horizon too long"). A free tier is a condition a
  provider can withdraw without notice; 0067's 90-day default is for invoices and contracts, not
  for a terms page. `staleAfterFrom(effectiveAt, 30)` is the way to compute it.
- Freshness is derived at resolution time, exactly as for a rate: `NOT_YET_EFFECTIVE`, `STALE`
  and `UNUSABLE_CLOCK` apply unchanged. `AMBIGUOUS` applies across both arms — a rate and a free
  tier for the same `modelId` is two competing entries, and neither is chosen.
- `resolvePrice` returns `{ kind: "FREE_TIER", record }`; `costMicros` returns
  `{ kind: "FREE_TIER", currency, micros: 0, provenance }` after the same token validation as a
  rate (`NOT_REPRESENTABLE` still fires on a negative or non-integer count). `UNPRICED_TOKENS`
  does not apply to a free-tier record: the record prices the *call*, not token classes, so
  reasoning or cache tokens above `prompt + completion` are covered by the same verified terms.
  `priceUsage` projects it to `CostOutcome` as
  `{ kind: "FREE_TIER", currency, amount: 0, modelId, provenance }`.
- `ICOS_PRICE_REGISTRY` stays `Object.freeze([])`. **No free-tier record for any real provider is
  written by this decision.** The NVIDIA NIM measurement above is a probe result, not a reading of
  NVIDIA's terms; writing a record for it from this document would be the fabrication 0067 §6
  forbids. The first real record enters when the owner has read the terms and the dashboard quota
  and writes the provenance line.
- `UNKNOWN_PRICE === UNPRICED` is unchanged. A zero rate, a missing record, a stale free tier and
  an unknown model all remain `UNPRICED`, each with its own `defect`. Only a usable `FREE_TIER`
  record says `FREE_TIER`.

The three facts are now three words with three different proofs: `UNPRICED` + `ABSENT`/`AMBIGUOUS`
(unknown model), `UNPRICED` + any other defect (unknown cost), `FREE_TIER` + provenance (nil cost,
verified on a date). Reports print `0 EUR (free tier, verified <date>)` from the third and never
from the first two.

### 2. The budget layer treats `FREE_TIER` as a priced call of zero, and a stale one as unknown

- `accumulate` (`src/core/budget/spend.ts`) adds `0` to `amount` and increments `pricedCalls`
  for a `FREE_TIER` observation, plus a new `freeTierCalls` counter so a window can say how many of
  its priced calls were free. It does **not** increment `unpricedCalls`: a verified free call is
  provable under a money cap, which is the point. `decide` therefore no longer refuses
  `UNPRICED_USAGE_IN_WINDOW` for a window made only of `COST` and `FREE_TIER` rows.
- **Token caps apply unchanged.** `maxTotalTokens` counts every token of a free-tier call, the
  request-bounds output ceiling is still written into the request, and `decideReservation` is
  untouched — it reserves tokens, and under a money cap it still refuses `UNPRICED_RESERVATION`
  because it takes no price at all (0067's recorded residue, not widened here). A free tier is
  free in money and bounded in tokens, which is what a provider quota is.
- **Monetary caps count 0 micros** for a free-tier call: `maxCostMicros` is compared against a
  sum the call did not increase. The inference plan's `worstCaseCost` (`inference-plan.ts`)
  resolves a `FREE_TIER` record to `0` micros, so `MONEY_CEILING_EXCEEDED` cannot fire for it,
  while `CONTEXT_BELOW_TOKEN_CEILING`, latency gates and the router's own exclusions apply as
  before.
- **Past `staleAfter`, a `FREE_TIER` record degrades to `UNPRICED` with defect `STALE`** — never
  to `COST`, never to a rate, never to "still free". Under `moneyEnforced` the inference plan
  then refuses the candidate `COST_UNPROVABLE: STALE`, and the spend window counts the call
  unpriced. An expired free tier is the single most likely way a "free" model starts costing money,
  so expiry is the one direction that must be loud. Re-verifying is a new record with a new date.
- Durable rows are dated proofs and are not rewritten (0055): a row recorded `FREE_TIER` on day 1
  stays `FREE_TIER` after the record expires on day 31; only new calls become `UNPRICED`.

### 3. `auto/*` combos are never admissible where an operator names a model

- `src/config/env.ts` rejects, at `loadEnv`, any entry of `ICOS_AUTONOMY_ALLOWED_MODELS` and any
  value of `ICOS_REVIEWER_MODEL` or `ICOS_PLANNER_MODEL` that starts with `auto/`
  (`AUTO_COMBO_NOT_ADMISSIBLE: <variable>`). The predicate is the one `compute-fleet.ts` already
  applies, moved to one shared `isMetaRoute(id)` so there is one definition of "not one model".
  `frozenIds` in `model-allowlist.ts` applies the same predicate, so a goal-level allowlist cannot
  name a combo either: the refusal is unexpressible, not merely unconfigured.
- Reason, measured, not assumed: a combo's served model is not the requested model
  (`auto/best-free` → `claude-opus-5`). An allowlist entry `auto/best-free` would admit Claude
  Opus 5 into a writer pool that never listed it, an `ICOS_REVIEWER_MODEL=auto/best-free` would
  make `SAME_MODEL_AS_WRITER` compare the alias instead of the judge, and a free-named alias would
  bill a paid model while the registry had no record to price it. The owner's "block the fallback
  from `auto/best-free` to an unauthorised paid model" is met by making the combo inexpressible
  rather than by inspecting what it served after the fact.
- **What is priced is the served model, and that is already the case.** Read in
  `src/server/budget/metered-fetch.ts`: the ledger row's `modelId` is
  `observed.model ?? requestedModel(init) ?? "UNKNOWN"`, where `observed.model` is the `model`
  field of the JSON answer (comment: "the model reported by the answer is the one that really
  ran, hence the one that bills") or `message_start.message.model` of an Anthropic stream
  (`src/core/budget/usage.ts`). The requested id is only a fallback for an answer that does not
  echo one. Consequence for this decision: a `FREE_TIER` record's `modelId` must be **the id as
  the gateway echoes it**, which 0064 recorded as a blind spot (`cc/claude-sonnet-5` and
  `claude/claude-sonnet-5` both answer `claude-sonnet-5`; the route prefix is lost). The
  verification probe that backs a record must therefore note the echoed `model` string in
  `verifiedQuota`, and a record keyed on an id the ledger never writes is `ABSENT` and visibly
  `UNPRICED` — the safe failure.
- **What `SAME_MODEL` checks compare is the requested or registered model, not the served one,
  and this decision does not change that.** Read in `worker-eligibility.ts` (the router compares
  the candidate's registered `metadata.model` with `writerModel`), in `omniroute-reviewer.ts`
  (`providerMetadata.model` is `input.reviewerCompute?.model ?? this.options.model`, i.e. the
  configured id) and in `workspace-execution-coordinator.ts` (`writerEffectiveModel` reads
  `routing_decision.selected`). With `auto/*` inexpressible, requested and served differ only by
  the route-prefix collision 0064 already names; closing that needs the gateway to echo its
  route, which is outside this decision. It is recorded here so nobody reads §3 as "independence is
  checked on the served model".
- Out of scope, flagged: `omniroute-ceo-client.ts` still names `auto/best-chat` and
  `auto/nvidia-chat` for the conversational lane. It is metered by the same decorator and priced
  by the served model, so its cost is honest; whether a conversation may be served by Opus 5 is a
  conversation-budget question for the owner, not an autonomy one, and is not decided here.

### 4. A provider is operational on dated evidence only; a price record is not evidence of that

- Nothing in ICOS marks a provider operational from configuration alone, and this decision adds
  nothing that would. Decision 0064 keeps three claims apart — `catalog presence != registered`,
  `registered != available`, `available != routable` — and health is the HTTP probe's dated
  answer, refreshed by the `probe_workers` sweep; 0054 puts a provider in `PROVIDER_COOLDOWN` for
  5 minutes on a 429 and a model in cooldown for 10 minutes on unavailability.
- A `FREE_TIER` record is a **price fact**, not a health fact. It makes a call cost 0 when the
  call happens; it does not make the call happen. A provider whose last dated probe is 5xx or 429
  is not operational whatever the registry says about its price, and the table in Context is the
  evidence: Groq (502 on both ids), four OpenRouter free variants (502/429), Gemini 3.5-flash
  (503) and every OpenCode `-free` id (403) are **not operational today** and must not receive a
  `FREE_TIER` record until a dated probe answers 200 and the terms are read. NVIDIA NIM
  nemotron super/ultra and OpenRouter nemotron-ultra:free are the only free candidates with both a
  200 and a passed golden task; they are candidates for a record, not holders of one.
- Correspondingly, a 200 does not make a free tier: Gemini flash-lite and Mistral codestral
  answered and have no confirmed free tier. They stay `UNPRICED` + `ABSENT`.

## Consequences

**Files that change when this is implemented** (none changed by this document):

- `src/core/pricing/registry.ts` — `PriceRecord` union with `kind: "RATE" | "FREE_TIER"`,
  `FreeTierPriceRecord`, `FREE_TIER_MAX_FRESHNESS_DAYS`, `recordDefect` arms, `FREE_TIER`
  outcomes in `PriceResolution` / `CostMicrosOutcome`, `costMicros` short-circuit after token
  validation. The `value <= 0` refusal on rate fields is untouched.
- `src/core/budget/contracts.ts` — `FREE_TIER` constant and the third `CostOutcome` arm;
  `SpendWindow.freeTierCalls`.
- `src/core/budget/price-table.ts` — `PriceEntry` gains an optional `kind` and `verifiedQuota`;
  `priceTableFrom` projects a free-tier record without inventing rates; `toRecord` maps a
  `kind: "FREE_TIER"` entry to the new arm and refuses one that also carries rates.
- `src/core/budget/spend.ts` — `accumulate` as in §2.
- `src/server/budget/postgres-spend-ledger.ts` and `in-memory-spend-ledger.ts` — write
  `cost_kind = 'FREE_TIER'`, `amount = 0`, `currency`, `free_tier_provenance`; `toObservation`
  reads the third word back (today its `else` branch would read an unknown word as `COST`, which
  is why the reader changes in the same commit as the writer).
- `src/server/mission/mission-trace.ts` — the entry line prints
  `0 EUR (free tier, verified <date>)` from `costKind` + `free_tier_provenance`, and the total
  line prints `… priced over N calls (M free tier), …`.
- `src/features/cockpit/truth-projection.ts` — `amount24h` is real when every call in the window
  is `COST` or `FREE_TIER`; `unpriced24h` keeps counting only `UNPRICED`.
- `src/core/workers/inference-plan.ts` — `worstCaseCost` returns `{ micros: 0 }` for a
  `FREE_TIER` resolution; recorded per stage as `costMicros: 0, costKind: "FREE_TIER"` so the
  evidence does not read as a measured rate.
- `src/config/env.ts`, `src/core/autonomy/model-allowlist.ts`, `src/server/workers/compute-fleet.ts`
  — the shared `isMetaRoute` predicate and the three refusals of §3.

**Schema: one migration, and why that option rather than `COST` + `price_kind`.**
`spend_ledger` carries the distinction in its row shape, not in application convention — that is
the stated principle of migration 0055 ("no writer, present or future, can launder an unknown into
a zero"). Two options were weighed:

- *(a)* widen `spend_ledger_cost_kind_check` to `('COST','UNPRICED','FREE_TIER')`, add
  `free_tier_provenance text`, and extend `spend_ledger_cost_shape` with
  `WHEN 'FREE_TIER' THEN amount = 0 AND currency IS NOT NULL AND unpriced_reason IS NULL AND
  free_tier_provenance IS NOT NULL`;
- *(b)* keep the CHECK, store `COST` with `amount = 0`, and add a `price_kind` column.

**(a) is chosen.** Today a `COST` row with `amount = 0` is reachable only by a metered call of
zero tokens (rates are strictly positive and a non-zero remainder rounds up), so "COST 0 with
tokens" is, in practice, a sign of a pricing bug. Under (b) it becomes the ordinary shape of every
free-tier call: a reader that ignores `price_kind` — every reader written before it — would see a
measured zero cost on real consumption and could not tell a verified free tier from that bug.
Under (a) an old reader fails loudly or must learn the third word (`toObservation`), and a
non-zero `FREE_TIER` amount is unrepresentable by constraint.
The provenance column exists because for a rate the amount is the proof, while for a free tier
the amount proves nothing and the dated verification is the proof; a later registry change must
not rewrite it (0055). Data safety: adding a nullable text column and widening two CHECKs is
catalog-only, rewrites no row, and every existing row satisfies the new constraints (its
`cost_kind` is `COST` or `UNPRICED`, its new column `NULL`); `ALTER TABLE` takes ACCESS EXCLUSIVE
briefly, as 0065 did. Rollback: drop the two widened constraints and restore the 0055 text, keep
the column and every row — any `FREE_TIER` row written in between must first be preserved or the
narrower CHECK will not validate; the migration header states this, in the 0065 pattern. Next
free number at the time of writing: `0066` (re-check at integration). Tenant key: `tenant_id`,
unchanged, first term of the only read index; RLS strategy unchanged (applicative isolation, as
every ICOS table).

**Tests to add** (each one a mutation the implementation must fail on):

- registry: a `FREE_TIER` record resolves `FREE_TIER` with `micros: 0`; the same record with
  `staleAfter` 31 days out is `INVALID_ENTRY`; past `staleAfter` it is `UNPRICED`/`STALE`, never
  `COST`; a `RATE` record with a zero rate is still `INVALID_ENTRY`; a `RATE` and a `FREE_TIER` for
  one `modelId` are `AMBIGUOUS`; blank `provenance` or `verifiedQuota` is `INVALID_ENTRY`; a
  `FREE_TIER` record never carries rate fields (type-level, plus `toRecord` refusal).
- budget: `accumulate` on a `FREE_TIER` observation leaves `amount` unchanged, increments
  `pricedCalls` and `freeTierCalls`, not `unpricedCalls`; `decide` under `maxCostMicros` allows a
  window of free-tier calls and still denies on `maxTotalTokens`; `decideReservation` is
  unchanged (regression pin).
- inference plan: a free-tier candidate passes `moneyEnforced` with a token ceiling, is refused
  `COST_UNPROVABLE: STALE` once expired, and is still refused `CONTEXT_BELOW_TOKEN_CEILING` when its
  context window is too small.
- ledger (PostgreSQL, isolated database): a `FREE_TIER` row round-trips with `amount = 0` and its
  provenance; `amount = 1` with `cost_kind = 'FREE_TIER'` is rejected by CHECK; a `COST` row with
  `amount = 0` is still writable only through `COST` semantics (documented, so the choice of (a) is
  visible in a test); the migration applies on a fresh database and on one holding 0055 rows.
- env: `ICOS_AUTONOMY_ALLOWED_MODELS=cc/claude-sonnet-5,auto/best-free`,
  `ICOS_REVIEWER_MODEL=auto/best-free`, `ICOS_PLANNER_MODEL=auto/coding:free` each refuse to
  start with `AUTO_COMBO_NOT_ADMISSIBLE`; `modelAllowlist(["auto/x"])` throws.
- metered-fetch: an answer whose `model` differs from the request is recorded under the answer's
  id (regression pin on the existing behaviour §3 relies on).
- mission-trace: a `FREE_TIER` entry prints `0 EUR (free tier, verified <date>)` and an
  `UNPRICED` entry still prints `UNPRICED`.

**What explicitly does not change:**

- Routing authority: OmniRoute and the canonical matcher (0054/0071). A price record selects
  nothing and promotes nothing; `rankComputePool` is not consulted differently.
- Budget caps and their semantics: `maxTotalTokens`, `maxCostMicros`, `UNCAPPED` as an explicit
  choice, `decideReservation`, the goal-tree single window (P0-B).
- `UNKNOWN_PRICE === UNPRICED`, the empty frozen registry, the `value <= 0` refusal, the
  90-day default for rates, integer micros.
- The independence rule (`sameEffectiveModel`) and which identities it compares.
- `compute-fleet.ts`'s existing `auto/*` skip (it is reused, not replaced).
- No free-tier record for any real provider; no production configuration; the N1 lab's
  `ICOS_REVIEWER_MODEL` / `ICOS_PLANNER_MODEL` proposal in the strategy document stays a proposal.

## Evidence

Read for this decision, on `feat/fable-5-1-convergence` at `62bf1a3`:
`src/core/pricing/registry.ts` (the `value <= 0` refusal at `recordDefect`, `UNKNOWN_PRICE =
UNPRICED`, `PriceRecord` requiring `provenance`/`effectiveAt`/`staleAfter`, `ICOS_PRICE_REGISTRY =
Object.freeze([])`); `src/core/budget/contracts.ts` (`CostOutcome` = `COST` | `UNPRICED`,
`DENY_REASONS`); `src/core/budget/price-table.ts` (`priceUsage`, `NEVER_STALE` projection);
`src/core/budget/spend.ts` (`accumulate`, `decideReservation` takes no price);
`src/core/workers/inference-plan.ts` (`worstCaseCost`, `COST_UNPROVABLE`);
`src/server/budget/metered-fetch.ts` and `src/core/budget/usage.ts` (served model is the ledger
id); `src/server/budget/postgres-spend-ledger.ts` (`toObservation` else-branch reads as `COST`);
`src/server/database/schema.ts` and `drizzle/0055_spend_ledger.sql` (`cost_kind IN
('COST','UNPRICED')`, `spend_ledger_cost_shape`), `drizzle/0065_spend_ledger_cache.sql` (the
catalog-only migration pattern); `src/config/env.ts` and `src/core/autonomy/model-allowlist.ts`
(no prefix validation); `src/server/workers/compute-fleet.ts` (`auto/*` skipped);
`src/server/review/omniroute-reviewer.ts`, `src/server/workspace-manager/integration-gate.ts`
and `workspace-execution-coordinator.ts` (which model id independence compares);
`src/features/cockpit/truth-projection.ts` and `src/server/mission/mission-trace.ts` (how cost
is printed); decisions 0054, 0064, 0067, 0071.

Measured facts: `docs/icos/OMNIROUTE_MODEL_STRATEGY_2026-10-14.md` (OmniRoute 3.8.49, 432 ids,
the probe states tabulated in Context, `auto/best-free` → `claude-opus-5`, NIM nemotron-ultra
6/6 on the reviewer golden tasks, no quota headers). No measurement was repeated and no provider
was called for this document.

Not evidence, stated as such: no provider's terms of use were read for this decision, which is
why it writes no record. Completion of the implementation requires the tests above to pass on an
isolated PostgreSQL and the migration to be proven on a fresh database and on one holding 0055
rows, in the 0065 pattern.
