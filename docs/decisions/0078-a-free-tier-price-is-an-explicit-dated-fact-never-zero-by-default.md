# 0078: A free-tier price is an explicit dated fact, never zero by default

## Status

Proposed (FABLE 5.1 convergence, 2026-10-14). **Owner's agreement in principle recorded on
2026-10-14** (verbatim below); the decision stays _Proposed_ because the evidence of gratuity
gathered on that date (§ Evidence of gratuity) does **not** yet meet the owner's own conditions
for any provider: NVIDIA publishes no numeric quota and restricts the trial to non-production
use, OpenRouter's daily quota depends on account facts no agent can read, and no account
dashboard was read. No registry entry is changed by this decision: the registry ships **empty**
of `FREE_TIER` records, and adding one is an owner act.

Implementation state (branch `feat/fable-free-tier-pricing`, base `5efdfca`):

- §3 (`auto/*` is never admissible where an operator names a model) is **already implemented**
  on this base by commits `3222949` (shared `isMetaRoute` in `src/core/workers/meta-route.ts`,
  refusals `AUTO_COMBO_NOT_ADMISSIBLE` in `src/config/env.ts` and
  `src/core/autonomy/model-allowlist.ts`, reuse in `compute-fleet.ts`) and `be79d36` (review
  follow-up: `no-think/` and `claude/` aliases, `claude/combo/<name>`, unrestricted-allowlist
  admission paths). Nothing in §3 is reimplemented here.
- §1, §2 and the schema option (a) are implemented and tested (unit, plus PostgreSQL on a
  throwaway database only — no existing database was migrated), in the commit that follows this
  document's revision. Option (a) is implemented with **two** proof columns instead of one
  (`free_tier_provenance`, `free_tier_verified_on`), see § Consequences.

Owner's decision of 2026-10-14, verbatim:

> ADR 0078 : accord de principe pour distinguer explicitement FREE_TIER, UNPRICED et les autres
> états de tarification. Finaliser l'ADR avec preuve de gratuité par provider et modèle, date de
> vérification, conditions et quotas. L'implémentation peut être préparée et testée sur une base
> PostgreSQL jetable, sans migration d'une base existante.

> Ne confonds jamais modèle inconnu, coût inconnu et coût réellement nul.

Extends 0067 (pricing is a dated registry, money is
integer micros), 0071 §6 (unknown money fails closed in an inference plan), 0054/0071 (OmniRoute
is the only routing authority) and 0064 (the fleet is reconciled, never enabled). The number is
provisional; parallel lanes have collided on decision numbers before, so the integrator re-checks
it. Owner's original instruction, verbatim:

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
§5): a model _believed_ to be free — NVIDIA NIM `nvidia/nvidia/nemotron-3-ultra-550b-a55b`, which
answered the reviewer golden tasks 6/6 with no charge observed by the probe (a probe is not a
reading of the terms, and § Evidence of gratuity shows the evidence is still incomplete) — is
**indistinguishable from a model whose price nobody knows**. Both are `UNPRICED`. Even once a
gratuity is proven, `spend_ledger` could not say "0 EUR" for it without lying about the other,
`pnpm mission:trace` prints the cost kind word for both, and the cockpit's `costMetric` shows
`UNPRICED n/m` for a mission whose calls might have been free. Three facts are being folded
into one word:

1. **unknown model** — the id is absent from the registry (`ABSENT`), or two entries compete
   (`AMBIGUOUS`);
2. **unknown cost** — the model is known but the price is not usable (`INVALID_ENTRY`,
   `NOT_YET_EFFECTIVE`, `STALE`, `UNPRICED_TOKENS`, `NOT_REPRESENTABLE`, `UNUSABLE_CLOCK`);
3. **a cost that is genuinely nil** — a provider whose free tier, quota and terms of use were
   verified on a stated date.

The third fact has no representation today, so the honest system prints "unknown" for it. The
tempting shortcut — admit a zero rate — would reintroduce the exact laundering 0067 closed: a
typed `0` is a typo until proven otherwise, and a free tier is a _term of use with an expiry_,
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

| Provider / id                                                           | Last dated probe                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `nvidia/nvidia/nemotron-3-super-120b-a12b`                              | 200 in 1.0 s                                                    |
| `nvidia/nvidia/nemotron-3-ultra-550b-a55b`                              | 200 in 0.7 s; reviewer certification 6/6                        |
| `nvidia/z-ai/glm-5.3`                                                   | 200 in 2.3 s; timeout on every reviewer task                    |
| `nvidia/*` deepseek-v4.1-flash, kimi-k3                                 | timeout 45 s; several ids 404 (stale catalogue)                 |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`                     | 200 in 0.9 s                                                    |
| `openrouter/*:free` (super, gemma-4-31b, north-mini, `openrouter/free`) | **502**, **429** (31 s), **502**, **502**                       |
| `groq/*` (gpt-oss-120b, gpt-oss-20b)                                    | **502** "upstream returned an empty response"                   |
| `oc/*-free` (OpenCode)                                                  | **403** "free tier can only be used from within OpenCode" / 400 |
| `gemini/gemini-3.1-flash-lite`                                          | 200 in 2.1 s; free tier not confirmed                           |
| `gemini/gemini-3.5-flash`                                               | **503** (35 s)                                                  |
| `mistral/codestral-latest`                                              | 200 in 0.3 s; free tier not confirmed                           |
| `auto/best-free`                                                        | 200, served `claude-opus-5`                                     |

OmniRoute returns no quota header; a 429 surfaces as "Provider returned error" with a per-id
cooldown. The only place quotas can be read is the gateway dashboard, by the owner.

## Decision

### 1. A third cost outcome, `FREE_TIER`, exists and is produced only by a dated registry record

`FREE_TIER` is a **third word**, beside `COST` and `UNPRICED`. It is never a `COST` of amount 0
and never an `UNPRICED` with a friendlier reason. It can only be produced by a registry record of
a new shape:

- `PriceRecord` becomes a discriminated union. The existing shape is `RatePriceRecord`, whose
  `kind` is `"RATE"` **or absent** (absent means RATE, so every existing rate record and fixture
  keeps its meaning); it is otherwise unchanged — including the `value <= 0` refusal, which stays
  exactly as it is. The new arm is `FreeTierPriceRecord`, and a free tier must say so: only an
  explicit `kind: "FREE_TIER"` produces one. Any other `kind` value is `INVALID_ENTRY`, never a
  rate by default.
- **A `FREE_TIER` record requires the evidence of gratuity, field by field** (all required, a
  blank is `INVALID_ENTRY`):

  | Field                   | Content                                                                                                                                          |
  | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `provider`              | the billing provider (e.g. `nvidia`, `openrouter`)                                                                                               |
  | `modelId`               | the id **as the gateway echoes it** in the answer (that is what the ledger writes, §3)                                                           |
  | `kind`                  | `"FREE_TIER"`                                                                                                                                    |
  | `provenance.source`     | URL (or document reference) of the terms / pricing page read                                                                                     |
  | `provenance.verifiedOn` | day of that reading, a real calendar day `YYYY-MM-DD`                                                                                            |
  | `conditions`            | conditions of use read (e.g. "trial, internal testing and evaluation only, not production; inputs may be used to improve the provider's models") |
  | `verifiedQuota`         | quota read (requests/minute, /day, credits, account tier) — or the explicit statement that the provider publishes none, never blank              |
  | `effectiveAt`           | not before `provenance.verifiedOn`                                                                                                               |
  | `staleAfter`            | at most **30 days** after `provenance.verifiedOn`                                                                                                |

  It has **no rate fields at all** (`promptMicrosPerMillion?: never`): there is no place in it to
  type a zero, and a record that carries one anyway (JSON, cast) is `INVALID_ENTRY`.

- `staleAfter` is required and **short**: `recordDefect` refuses a `FREE_TIER` record whose
  horizon exceeds `FREE_TIER_MAX_FRESHNESS_DAYS = 30` counted from the **verification day**
  (not from a later `effectiveAt`, which would let a record outlive its reading). A free tier is
  a condition a provider can withdraw without notice; 0067's 90-day default is for invoices and
  contracts, not for a terms page. `staleAfterFrom(effectiveAt, 30)` with
  `effectiveAt = verifiedOn` is the way to compute it.
- Freshness is derived at resolution time, exactly as for a rate: `NOT_YET_EFFECTIVE`, `STALE`
  and `UNUSABLE_CLOCK` apply unchanged. `AMBIGUOUS` applies across both arms — a rate and a free
  tier for the same `modelId` is two competing entries, and neither is chosen.
- Dates are **real calendar days**: `Date.parse` normalises an impossible day (`2026-02-30`
  becomes 2 March), so `verifiedOn`, and the `YYYY-MM-DD` head of `effectiveAt`/`staleAfter`
  (rates included), must round-trip exactly or the record is `INVALID_ENTRY` — before anything
  reaches the ledger's `date` column.
- `resolvePrice` returns `{ kind: "FREE_TIER", record }`. Only a resolution produces a free-tier
  cost: `priceUsageMicros` turns that resolution into
  `{ kind: "FREE_TIER", modelId, currency, micros: 0, provenance }` through a module-internal
  helper. The exported `costMicros` accepts a **rate** only; a `FREE_TIER` record cast into it
  is `INVALID_ENTRY`, so no exported path skips `recordDefect` and the freshness window. The
  free-tier cost runs the same token validation as a rate (`NOT_REPRESENTABLE` still fires on a negative or non-integer count). `UNPRICED_TOKENS`
  does not apply to a free-tier record: the record prices the _call_, not token classes, so
  reasoning or cache tokens above `prompt + completion` are covered by the same verified terms.
  `priceUsage` projects it to `CostOutcome` as
  `{ kind: "FREE_TIER", currency, amount: 0, modelId, provenance }`.
- `ICOS_PRICE_REGISTRY` stays `Object.freeze([])`: **the registry ships EMPTY of `FREE_TIER`
  records, and adding one is an owner act.** No free-tier record for any real provider is written
  by this decision nor by its implementation. The NVIDIA NIM measurement above is a probe result;
  the terms read on 2026-10-14 (§ Evidence of gratuity) are evidence, but incomplete evidence
  (no published quota, non-production clause), and turning them into a record would be a choice
  the owner has not made. The first real record enters when the owner has read the account's
  dashboard quota, accepted the conditions for ICOS's use, and writes the provenance line.
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

_Implemented on the base of this branch by `3222949` and `be79d36` (see Status). The text below
is the decision as taken; it is not reimplemented._

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

## Evidence of gratuity (read 2026-10-14)

Read-only, official sources only (provider pages, terms, public catalogue APIs and docs); no
model was called, no account page was opened, no key was used. "non vérifié" means the official
source could not be reached, or does not state the fact — never inferred. Third-party pages and
forum posts by users were **not** taken as evidence (the frequently quoted "40 requests per
minute" for NVIDIA comes from forum users and is therefore _non vérifié_). Measured availability
is copied from `docs/icos/OMNIROUTE_MODEL_STRATEGY_2026-10-14.md` (probes of 2026-10-14, not
repeated).

Sources (all read on 2026-10-14):

- **[N1]** NVIDIA model page, `https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b`:
  "The trial service is governed by the NVIDIA API Trial Terms of Service."
- **[N2]** NVIDIA model page, `https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b`:
  same sentence.
- **[N3]** NVIDIA API Trial Terms of Service, version line "v. September 19, 2025",
  `https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf`
  (text extracted from the PDF, quotes verbatim):
  §1.1 "Subject to use limits defined by NVIDIA"; §1.2 "access to the API Service for limited
  trial purposes only and without use of the API Service or Generated Content in production";
  §1.4 "Your use of an API Service may be limited to a certain number of API access instances or
  by API access duration. NVIDIA may extend trial service credits […] NVIDIA will deduct Credits
  based on your usage […] Unless you purchase a Subscription from NVIDIA or a Service Provider
  (as applicable), you may only use the API Service for internal testing and evaluation
  purposes, not in production"; §2.6 no "confidential information, controlled or sensitive data
  […] personal data (unless expressly permitted by an API Service)"; §3.3 NVIDIA collects
  "User Content and Generated Content to improve NVIDIA products and services, including AI
  models", and use "will be logged for security, fraud or abuse monitoring"; §15.7 terms "may
  update […] effective when published". The terms contain **no fee schedule and no numeric
  quota**.
- **[N4]** NVIDIA NIM FAQ by NVIDIA staff (`https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317`,
  posted 2024-09-11): the API catalog is "a trial experience of NVIDIA NIM" for "evaluation and
  prototyping needs only"; "The rate of requests will vary per model queried and may vary based
  on the number of concurrent users." No number.
- **[O1]** OpenRouter public catalogue `https://openrouter.ai/api/v1/models` (462 models):
  `pricing.prompt = "0"`, `pricing.completion = "0"` for
  `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3-super-120b-a12b:free`,
  `google/gemma-4-31b-it:free`, `cohere/north-mini-code:free`, `openrouter/free`; the paid
  `nvidia/nemotron-3-ultra-550b-a55b` is listed at 0.0000006 / 0.0000024 USD per token.
- **[O2]** OpenRouter endpoints API,
  `https://openrouter.ai/api/v1/models/nvidia/nemotron-3-ultra-550b-a55b:free/endpoints`: one
  endpoint, provider `Nvidia`, name `nvidia/nemotron-3-ultra-550b-a55b-20260604:free`, pricing
  0 / 0, `data_policy: null`, context 1 000 000, max completion 65 536.
- **[O3]** OpenRouter rate limits, `https://openrouter.ai/docs/api-reference/limits`: for a
  "free model variant (with an ID ending in `:free`)": **20 requests per minute**; **50
  requests per day** with less than **10** credits purchased (all time), **1 000 per day** with
  at least 10 (constants `FREE_MODEL_RATE_LIMIT_RPM=20`, `FREE_MODEL_NO_CREDITS_RPD=50`,
  `FREE_MODEL_HAS_CREDITS_RPD=1e3`, `FREE_MODEL_CREDITS_THRESHOLD=10` in the page); the
  account's own ceiling is reported by `free_model_daily_requests` on `GET /api/v1/key`; a 429
  can come from OpenRouter or from the upstream provider.
- **[O4]** OpenRouter privacy/logging docs (`https://openrouter.ai/docs/features/privacy-and-logging`):
  training opt-out is an account setting, "There are separate settings for paid and free
  models"; with opt-out, "OpenRouter will not route to providers that train".

| Provider                       | Model id requested (echoed id not captured)         | Source                     | Conditions of use (read)                                                                                                                                                                                                                                                                                        | Quota / rate limits (read)                                                                                                                                                       | Measured 2026-10-14                               | Gratuity verified?                                                                                                                                       |
| ------------------------------ | --------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NVIDIA API Catalog (NIM trial) | `nvidia/nvidia/nemotron-3-ultra-550b-a55b`          | [N1] [N3] [N4]             | trial only; **not in production**; "internal testing and evaluation" unless a paid Subscription; credits deducted per use; inputs/outputs may be used to improve NVIDIA models; no confidential/personal data                                                                                                   | **non vérifié**: "use limits defined by NVIDIA", "will vary per model", no number published; account credits/limits only on the account page (owner)                             | 200 in 0.7 s; reviewer golden tasks 6/6           | **Partially**: no-charge trial _credits_ and conditions read; quota not published; production clause unresolved for ICOS → **insufficient for a record** |
| NVIDIA API Catalog (NIM trial) | `nvidia/nvidia/nemotron-3-super-120b-a12b`          | [N2] [N3] [N4]             | same as above                                                                                                                                                                                                                                                                                                   | **non vérifié** (same)                                                                                                                                                           | 200 in 1.0 s; golden PASS (weaker: RCE not named) | **Partially**, same reasons → insufficient                                                                                                               |
| NVIDIA API Catalog             | `nvidia/z-ai/glm-5.3`                               | model page **not read**    | non vérifié                                                                                                                                                                                                                                                                                                     | non vérifié                                                                                                                                                                      | 200 in 2.3 s; **timeout** on every reviewer task  | not a candidate (fails golden)                                                                                                                           |
| NVIDIA API Catalog             | `nvidia/*` deepseek-v4.1-flash, kimi-k3             | not read                   | non vérifié                                                                                                                                                                                                                                                                                                     | non vérifié                                                                                                                                                                      | timeout 45 s; several 404                         | **not operational**                                                                                                                                      |
| OpenRouter                     | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | [O1] [O2] [O3] [O4]        | price 0/0 in the catalogue; endpoint provider labelled `Nvidia` (`…-20260604:free`); whether NVIDIA's API Trial terms [N3] (non-production, data use §3.3) apply to this OpenRouter-served endpoint is **non vérifié**; endpoint `data_policy` **non publié**; OpenRouter general terms of service **not read** | **20 req/min; 50 req/day (< 10 credits purchased) or 1 000 req/day (≥ 10)** — which applies to the ICOS account is **non vérifié** (needs `GET /api/v1/key` with the key, owner) | 200 in 0.9 s                                      | **Partially**: price 0 and platform quota read; account tier and data policy unverified → insufficient                                                   |
| OpenRouter                     | `openrouter/*nemotron-3-super*:free`                | [O1] [O3]                  | price 0/0                                                                                                                                                                                                                                                                                                       | as above                                                                                                                                                                         | **502**                                           | **not operational**                                                                                                                                      |
| OpenRouter                     | `openrouter/*gemma-4-31b*:free`                     | [O1] [O3]                  | price 0/0                                                                                                                                                                                                                                                                                                       | as above                                                                                                                                                                         | **429** (31 s)                                    | **not operational**                                                                                                                                      |
| OpenRouter                     | `openrouter/*north-mini-code*:free`                 | [O1] [O3]                  | price 0/0                                                                                                                                                                                                                                                                                                       | as above                                                                                                                                                                         | **502**                                           | **not operational**                                                                                                                                      |
| OpenRouter                     | `openrouter/free`                                   | [O1]                       | price 0/0; it is OpenRouter's own router (served model chosen by OpenRouter), i.e. a meta-route like `auto/*`                                                                                                                                                                                                   | as above                                                                                                                                                                         | **502**                                           | **not operational**, and never admissible as one model                                                                                                   |
| Groq                           | `groq/*` gpt-oss-120b, gpt-oss-20b                  | **not read**               | non vérifié                                                                                                                                                                                                                                                                                                     | non vérifié                                                                                                                                                                      | **502** "upstream returned an empty response"     | **not operational**                                                                                                                                      |
| OpenCode                       | `oc/*-free`                                         | provider's own 403 message | "free tier can only be used from within OpenCode"                                                                                                                                                                                                                                                               | —                                                                                                                                                                                | **403** / 400                                     | **not usable** by ICOS                                                                                                                                   |
| Google Gemini                  | `gemini/gemini-3.1-flash-lite`                      | not read                   | non vérifié                                                                                                                                                                                                                                                                                                     | non vérifié                                                                                                                                                                      | 200 in 2.1 s                                      | **non vérifié** → stays `UNPRICED` + `ABSENT`                                                                                                            |
| Google Gemini                  | `gemini/gemini-3.5-flash`                           | not read                   | non vérifié                                                                                                                                                                                                                                                                                                     | non vérifié                                                                                                                                                                      | **503** (35 s)                                    | **not operational**                                                                                                                                      |
| Mistral                        | `mistral/codestral-latest`                          | not read                   | non vérifié                                                                                                                                                                                                                                                                                                     | non vérifié                                                                                                                                                                      | 200 in 0.3 s                                      | **non vérifié** → stays `UNPRICED` + `ABSENT`                                                                                                            |

Reading of the table against the owner's conditions (proof per provider and model, verification
date, conditions, quotas):

- **No row satisfies all four.** The best two (NVIDIA NIM nemotron ultra/super, OpenRouter
  nemotron-ultra:free) have a dated source and read conditions, but NVIDIA publishes no quota
  and OpenRouter's applicable daily quota depends on the account's purchase history. Both
  facts are on account pages that require the owner's session; an agent does not read them.
- **NVIDIA's trial excludes production.** Whether ICOS's autonomous development loop is
  "internal testing and evaluation" or "production" in the sense of [N3] is a legal reading for
  the owner, not an engineering inference. Until the owner answers it, a `FREE_TIER` record for
  `nvidia/*` would assert a right ICOS may not have.
- **Data use.** [N3] §3.3 lets NVIDIA use prompts and outputs to improve its models when the
  NVIDIA API catalog is used directly. The OpenRouter free endpoint names `Nvidia` as provider,
  but which terms govern it (OpenRouter's, NVIDIA's API Trial terms, or another agreement) is
  **non vérifié**; it must be treated as possibly training on prompts. Prompts carrying repository content, secrets or
  tenant data must not go to these endpoints regardless of price; this is a routing/data policy
  question that a price record does not answer and must not be read as answering.
- **The echoed model id is unverified.** A record must be keyed on the id the gateway echoes
  (§3). The probes recorded the requested ids; the echoed `model` string was not captured, so
  even a complete record would need one dated probe noting it.
- Groq, four OpenRouter free variants, Gemini 3.5-flash and every OpenCode `-free` id are **not
  operational** on 2026-10-14 (502/429/503/403) and must not receive a record whatever their
  price (§4).

What would make a record admissible (owner act, per model): read the account quota/credits in
the provider dashboard (NVIDIA) or `free_model_daily_requests` (OpenRouter) and write it in
`verifiedQuota`; decide that ICOS's use is within the stated conditions and write them in
`conditions`; take one dated probe noting the echoed model id; set
`effectiveAt = verifiedOn`, `staleAfter = staleAfterFrom(effectiveAt, 30)`; commit the record.

## Consequences

**Files changed by the implementation** (branch `feat/fable-free-tier-pricing`; §3's files were
already changed on the base by `3222949`/`be79d36`):

- `src/core/pricing/registry.ts` — `PriceRecord` union with `kind: "RATE" | "FREE_TIER"`,
  `FreeTierPriceRecord`, `FREE_TIER_MAX_FRESHNESS_DAYS`, `recordDefect` arms, `FREE_TIER`
  outcomes in `PriceResolution` / `CostMicrosOutcome`; free-tier costing only through a
  resolution (module-internal helper), `costMicros` rate-only; real-calendar-day check on
  `verifiedOn`/`effectiveAt`/`staleAfter`. The `value <= 0` refusal on rate fields is untouched.
- `src/core/budget/contracts.ts` — `FREE_TIER` constant and the third `CostOutcome` arm;
  `SpendWindow.freeTierCalls`.
- `src/core/budget/price-table.ts` — `PriceEntry` becomes `RatePriceEntry | FreeTierPriceEntry`
  (the free arm requires `effectiveAt`/`staleAfter`: no `NEVER_STALE` for a free tier);
  `priceTableFrom` **validates every record with `recordDefect` before projecting it** and
  projects a refused record as `RefusedPriceEntry { kind: "REFUSED", defect }` (otherwise copying
  the known fields would silently drop a forbidden rate field and turn an `INVALID_ENTRY` into a
  `FREE_TIER`); a valid free-tier record is projected without inventing rates; `toRecord` maps a
  `kind: "FREE_TIER"` entry to the new arm, refuses one that also carries rates, and refuses an
  unknown `kind`.
- `src/core/budget/spend.ts` — `accumulate` as in §2.
- `src/server/budget/postgres-spend-ledger.ts` — writes `cost_kind = 'FREE_TIER'`, `amount = 0`,
  `currency`, `free_tier_provenance`, `free_tier_verified_on`; `toObservation` reads the third
  word back, and an **unknown** `cost_kind` is now read as `UNPRICED` instead of falling into the
  old `else` → `COST` branch (that is why the reader changes in the same commit as the writer).
  `MissionSpendRow.freeTier` carries the dated proof to the trace. `in-memory-spend-ledger.ts`
  needs no change: it prices through `priceUsage` and folds through `accumulate`.
- `src/server/mission/mission-trace.ts` — the entry line prints
  `0 EUR (free tier, verified <date>)` from `costKind` + `free_tier_provenance`, and the total
  line prints `… priced over N calls (M free tier), …`.
- `src/features/cockpit/truth-projection.ts` / `load.ts` — **no change needed**, read: the
  cockpit counts `amount IS NULL` rows as unpriced and sums `amount`; a `FREE_TIER` row has
  `amount = 0` NOT NULL by CHECK, so `amount24h` is already real when every call is `COST` or
  `FREE_TIER`, and `unpriced24h` already excludes free-tier rows.
- `src/core/workers/inference-plan.ts` — `worstCaseCost` returns `{ micros: 0 }` for a
  `FREE_TIER` resolution; the candidate records `worstCaseCostMicros: 0, costKind: "FREE_TIER"`
  so the evidence does not read as a measured rate.
- `src/server/database/schema.ts` + `drizzle/0066_spend_ledger_free_tier.sql` + journal entry
  (idx 62) — see Schema below.
- (§3, already on the base) `src/config/env.ts`, `src/core/autonomy/model-allowlist.ts`,
  `src/core/workers/meta-route.ts`, `src/server/workers/compute-fleet.ts`.

**Schema: one migration, and why that option rather than `COST` + `price_kind`.**
`spend_ledger` carries the distinction in its row shape, not in application convention — that is
the stated principle of migration 0055 ("no writer, present or future, can launder an unknown into
a zero"). Two options were weighed:

- _(a)_ widen `spend_ledger_cost_kind_check` to `('COST','UNPRICED','FREE_TIER')`, add
  `free_tier_provenance text` and `free_tier_verified_on date`, and extend
  `spend_ledger_cost_shape` with `WHEN 'FREE_TIER' THEN amount IS NOT NULL AND amount = 0 AND
currency IS NOT NULL AND unpriced_reason IS NULL AND free_tier_provenance` non-blank `AND
free_tier_verified_on IS NOT NULL`, every other arm requiring both proof columns NULL
  (`amount IS NOT NULL` is explicit because `NULL = 0` is NULL, which a CHECK accepts);
- _(b)_ keep the CHECK, store `COST` with `amount = 0`, and add a `price_kind` column.

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
briefly, as 0065 did. Rollback: drop the two widened constraints and restore the 0055 text
`NOT VALID`, keep both columns and every row — the table is append-only, so a `FREE_TIER` row
written in between is kept as evidence while new writes are narrowed back; `VALIDATE
CONSTRAINT` returns to 0055's validated state when no such row exists. The migration header
states this, in the 0065 pattern. Limit of the idempotence guard: each constraint is replaced
only when its definition does not contain `FREE_TIER` (`LIKE '%FREE_TIER%'`); a pre-existing,
divergent constraint of the same name that happens to mention `FREE_TIER` would be kept as is.
The guard proves "already widened by this migration" on the expected states (fresh, 0065,
replay, after the header rollback), not equivalence with an arbitrary pre-existing definition;
an integrator applying 0066 to a hand-modified database must compare `pg_get_constraintdef`
with the file first. `0066` was free on every local ref (97) and worktree on
2026-10-14 (re-check at integration). The verification day is a separate `date` column rather
than text inside `free_tier_provenance`, so the trace prints it without parsing and a CHECK can
require it. Tenant key: `tenant_id`, unchanged, first term of the only read index; RLS strategy unchanged (applicative isolation, as
every ICOS table).

**Tests** (each one a mutation the implementation must fail on). Registry, budget, inference
plan, ledger and mission-trace items are added by the implementation commit; the env items were
added by `3222949`/`be79d36`; the metered-fetch pin already exists
(`metered-fetch.test.ts`, "impute au modèle rapporté par la réponse, pas à celui demandé"):

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

Terms of use and quotas read on 2026-10-14 are listed in § Evidence of gratuity, with what
could not be verified. They are evidence for the owner's decision, not a record: the registry
still writes none. Completion of the implementation requires the tests above to pass on an
isolated PostgreSQL and the migration to be proven on a fresh database and on one holding 0055
rows, in the 0065 pattern (done on a throwaway PostgreSQL 14 container; see the implementation
commit message for the counts).
