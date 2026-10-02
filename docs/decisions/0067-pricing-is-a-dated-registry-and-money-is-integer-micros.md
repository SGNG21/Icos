# 0067 — Pricing is a dated registry, and money is integer micros

- Status: accepted
- Date: 2026-10-02
- Lane: `feat/big-autonomy-ui-self-improve`
- Extends 0066 (which recorded that the price table ships empty and why).

## Numbering hazard

This lane claims `0067`; central owned `..0064` when it was cut and this lane also claims `0065`
(chief supervisor) and `0066`. Parallel lanes in this repository have collided on decision numbers
silently before, because differing filenames merge with no conflict. **Re-check at integration.**

## Context

A monetary budget is only as trustworthy as its prices. The previous state was honest but thin: a
single flat `price-table.ts`, deliberately empty, where an entry carried a `provenance` and an
`asOf` string and nothing prevented an undated or永-fresh price from being hand-written into the
literal. That is the shape in which a wrong number quietly becomes a number someone budgets
against.

## Decision

**1. A tariff is a dated record or it does not exist.** `PriceRecord` requires provider, modelId,
currency, prompt and completion rates, provenance, `effectiveAt` **and** `staleAfter`. There is no
representable shape for an undated price.

**2. Freshness is derived, never stored.** A stored `status` field can lie after the fact. The
registry computes `NOT_YET_EFFECTIVE` / `STALE` from the dates at resolution time, alongside
`ABSENT`, `AMBIGUOUS` (two competing entries ⇒ neither is chosen), `INVALID_ENTRY`,
`UNPRICED_TOKENS`, `NOT_REPRESENTABLE` and `UNUSABLE_CLOCK`, each carried as a machine-readable
`defect` beside a human reason.

**3. `UNUSABLE_CLOCK` exists because of a real fail-open.** `NaN >= staleAfter` evaluates to
`false`, so without an explicit finiteness guard an unreadable clock made **every expired tariff
look fresh**. Fail-closed: if freshness cannot be verified, the price is unknown. Mutation-verified
— disabling the guard fails that test and only that test.

**4. Money is integer micros internally — millionths of the budget currency.** Cents were
considered and rejected with a concrete reason: 1 000 tokens at 3 per Mtok is 0.3 cent, which
rounds to zero, so a cap expressed in cents would never bite. Integer division is exact
(`n - (n % 1e6)`) rather than `Math.ceil(n / 1e6)`, whose float quotient can be off by one micro,
and a non-zero remainder rounds **up**, because under a cap over-estimating is the safe direction.

**5. `UNKNOWN_PRICE` is the same value as `UNPRICED`.** One word on the wire, not a second
vocabulary a consumer could fail to handle and read as "priced".

**6. The registry ships `Object.freeze([])` and `ICOS_PRICE_TABLE` is a frozen projection of it.**
There is no literal left in which to hand-write a real tariff, and nothing can inject one at
runtime. Every test fixture is `test/model` / provider `test`. **No price for any real model —
OmniRoute, NVIDIA, OpenAI, Anthropic — is written anywhere in this repository.** Writing one from
memory would be a fabrication, and a monetary ceiling computed on a fabricated tariff is worse
than no ceiling at all.

## Consequences

- A EUR ceiling on a model with no trustworthy price **fails closed** (tested).
- A **token-only** cap remains fully usable against an empty registry (tested). Euro pricing is
  therefore never a prerequisite for autonomy, which is the property that lets a bounded
  autonomous mission run at all.
- A stale or future-dated entry degrades to unknown instead of producing a quietly wrong amount.
- Known residue, recorded rather than hidden: `CostOutcome.amount` is still a float EUR at the
  legacy boundary owned by another lane, so exactly one float division survives in
  `microsToAmount`. The follow-up is to carry micros through `CostOutcome`/`SpendWindow` so money
  never becomes a float at all. A hand-built legacy entry without `staleAfter` validates as
  `NEVER_STALE`; the hole is closed from the other side, since real prices can only enter through
  the registry.
