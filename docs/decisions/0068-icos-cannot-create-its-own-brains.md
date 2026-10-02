# 0068 — ICOS cannot create its own brains, and that is the answer to `workforce_agents = 0`

- Status: accepted
- Date: 2026-10-02
- Lane: `feat/big-autonomy-ui-self-improve`
- Closes the investigation opened by 0066 (Decision 3) into why `workforce_agents` is 0.

## Numbering hazard

This lane claims `0065`, `0066`, `0067` and now `0068`; central owned `..0064` when it was cut.
Re-check all four at integration — differing filenames merge with no conflict.

## The question

`workforce_agents = 0` has been carried as an open defect across several sessions. 0066
reclassified it as "registry not seeded, by design". This decision records the rest of the answer,
which is stronger and was only found by trying to close it.

## What was built

The twelve brains are validated data on the existing schema. A seeder now exists
(`src/server/workforce/brain-seed.ts`) and goes through `WorkforceService.createAgent` rather than
inserting rows directly — so the single writer, the org bounds, the lineage derivation and the
`agent.created` event all still apply. And the registry is no longer inert: the missing CORE3 call
site is wired (`SupervisorService.routeReadyTask` ← `workforceTaskCompute` ← `requestFor`), so a
brain can now influence a real dispatch.

## Two human governance acts stand between that and twelve live brains

**1. The roles must be certified and activated by a human.** All 24 bootstrap roles ship
`status: "draft"` (verified), and `evaluateAgentCreation` refuses a draft role with
`ROLE_NOT_ACTIVE`. No production path certifies a role; `certifyRole` appears only in test
support. Certification takes evidence of tests passed — so a seeder that certified its own roles
would be **forging certification evidence**. The seeder therefore refuses per brain with
`ROLE_NOT_ACTIVE` and says so, and a test proves zero rows are written in that state.

**2. Seeding requires a HUMAN principal.** `isWorkforceAdmin` requires
`principal.kind === "human"` **and** the `agents.manage` permission. An issued system principal
has `kind: "system"` and `permissions: []`, so it can never create an agent. The
`workforce-bootstrap` identifier that appears in `roles.json` is a `createdBy` provenance string,
not an admin principal.

## Decision

**Neither gate is to be bypassed, and no CLI or route that fabricates a human principal will be
added.** `workforce_agents = 0` is therefore not a defect to fix but a gate functioning as
designed: it is "ICOS may never grant itself new authority" applied to organisational structure.
Organisational identity, tool grants and autonomy are human acts.

Consequence for the report, stated plainly: **BRAINS_CREATED = 0**, and it will stay 0 until a
human certifies the nine reused roles and runs the seeder under their own `agents.manage`
principal. The engineering is done; the authority is deliberately not ours to assert.

## What a human needs to do, once

1. Certify and activate the nine roles listed in `BRAIN_ROLES` (`src/core/workforce/brains.ts`),
   with real test evidence.
2. Invoke `seedBrains` holding an authenticated `agents.manage` session. It is idempotent: an
   existing brain is reported `already-present` and never overwritten, because a seeder must not
   silently reset durable governed state.

After that the brains are load-bearing immediately, because the dispatch seam is already live.

## Residual gaps, recorded not hidden

- Nothing creates workforce *assignments* in production yet: `WorkforceService.delegate` accepts
  an agent principal (the Chief brain via `runtime.actAsAgent`), and `src/core/chief/delegation.ts`
  still has no caller. The seam is composed and tested but not traversed end to end.
- CORE3 carries no tenant (`tasks`/`missions` have no `tenant_id`), so the adapter takes the
  tenant from the issued `core3-dispatch` system principal — the documented single-tenant shim,
  not a hardcoded literal.
