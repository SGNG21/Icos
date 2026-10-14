# Independent review — W9 commit 6daef30 "feat(w9): persist and report independent cache counters"

Reviewer: Claude (Fable 5.1), independent of the author (GPT/Codex). Read-only: `git show`/`git log`/`git ls-tree`/`cat` only. No test executed, no DB touched.
Lineage: `6daef30` is the tip of `feat/fable-n1-w9-cache-ledger` = `794b6ea` (authorised base) + `fd09189` (W10) + `6daef30`. Convergence HEAD `8e25920` adds one unrelated gate commit on top of `794b6ea`; no file overlap.
Contract: `docs/icos/handoffs/w10-w9-cache-contract-2026-10-12.md` (read fully).

## Verdict: REQUEST_CHANGES

The code conforms to the contract ("absent = unknown, 0 = measured") end to end; I found no `?? 0`, `Number(null)`, SQL default or coalesce that launders an unknown into a zero, tenant predicates are intact, and every value is parameterised. What blocks approval is not the code but (1) the absence of any evidence that the PostgreSQL integration proof was executed — the test file itself says "Prepared only" — while the contract makes the read-back-from-DB proof the acceptance criterion, and (2) a migration file that carries no data-safety/rollback analysis and no idempotency guard, contrary to the ICOS database rule and to every sibling migration (0055, 0062, 0063, 0064).

## Findings

| # | Severity | File:line | Defect | Evidence |
|---|----------|-----------|--------|----------|
| 1 | HIGH (evidence) | `src/server/budget/postgres-spend-ledger.integration.test.ts:100-101`; commit message | Durability proof not executed / not attached. The commit adds the right integration tests but nothing shows they ran against a database; the author's own comment says they are "Prepared only". | Comment in the commit: `// Prepared only: run serially on a dedicated disposable PostgreSQL instance` / `// after applying the migration there. Never target the shared test database.` Contract: "Les mocks SQL seuls ne prouvent pas la persistance. La preuve finale doit inclure les valeurs relues en base et leur restitution." CLAUDE.md: "completion requires evidence". Commit message carries no run output. |
| 2 | MEDIUM | `drizzle/0065_spend_ledger_cache.sql:1-9` | No DATA SAFETY / ROLLBACK analysis and not idempotent (no `IF NOT EXISTS`, no `pg_constraint` guard). A second hand-application (the documented path for the live DB, `psql -f`) fails with 42701 duplicate_column instead of being a no-op. | Whole file is one comment line + one `ALTER TABLE ... ADD COLUMN cache_read bigint, ADD COLUMN cache_creation bigint, ADD CONSTRAINT ...`. Sibling 0064: "DATA SAFETY ... Guarded and idempotent. ROLLBACK ..."; 0062: "Purely additive ... Idempotent. ROLLBACK ..."; 0055: "every statement is guarded ... re-running the migration is a no-op. ROLLBACK ...". `.claude/rules/database.md`: "Migrations require rollback/data-safety analysis." `docs/icos/database-migrations.md`: "fixes are new forward, idempotent migrations"; live DB "applied by hand (psql -f, both idempotent)". |
| 3 | MEDIUM (process) | commit as a whole | The contract requires a distinct authorisation before a migration is created, and separate approval of migration / schema / restitution interfaces; the commit bundles all three and references no authorisation. | Contract: "évolution additive nullable à proposer par W9, sans application ni création de migration autorisée à cette étape"; "Autorisation distincte avant création/application d'une migration ou toute intégration"; "Faire approuver séparément la migration, le schéma et les interfaces de restitution." Ownership handoff (2026-10-12): "Aucun run 11, migration, rebase ...". No later authorisation found in the repo or the untracked handoffs. Owner must confirm; not a code defect. |
| 4 | LOW | `postgres-spend-ledger.integration.test.ts:79,100-101` | Misleading comment: "Never target the shared test database" sits inside the suite that targets `TEST_DATABASE_URL` (the shared `icos_test`) and truncates it in `beforeEach`. Also the suite title still says "migration 0055" and nothing states that, since `record()` now names `cache_read, cache_creation`, every pre-existing integration test in this file and in `postgres-spend-reservations.integration.test.ts` now requires 0065. | `describe("spend_ledger (base de test locale, migration 0055)"`; `ctx = { handle: createDatabase(TEST_DATABASE_URL, ...) }`. `scripts/test-db-setup.ts:44` applies the journal (`migrate(drizzle(sql), { migrationsFolder: "drizzle" })`), so 0065 is applied automatically — the comment should say that instead. |
| 5 | LOW | `src/server/mission/mission-trace.ts:436-441` | Coverage is not reported. Per-row values are printed and NO aggregate cache total is announced (good), but the contract also asks to report coverage per counter. | Contract: "rapporter les valeurs connues et la couverture ; ne pas annoncer un total cache complet sur une couverture partielle"; "restituer une somme des valeurs connues avec une couverture explicite par compteur". Total line (443-446) has no cache field at all. |
| 6 | LOW | `src/server/budget/postgres-spend-reservations.test.ts:284-315` | Settlement of the cache split is proven only against `FakeTxDb` (SQL-shape mock); not on a real DB. Contract asks for the disposable-DB proof "réservations comprises". | Mitigation: `postgres-spend-reservations.ts:241` `await this.ledgerOn(tx).record({ ...entry, attribution });` — the same INSERT as the direct path, so the DB-level proof of `record()` transfers once it exists (finding 1). |
| 7 | INFO | `src/server/budget/postgres-spend-ledger.test.ts:~419-425` | `expect(folding.mock.calls[0][1].usage).toEqual(...)` — `toEqual` ignores `undefined`-valued keys, so a regression producing `cache: { read: undefined }` would still pass. `toStrictEqual` would be tighter. Current implementation never produces that shape. | `toObservation` builds `cache` only with `!= null` guards (ledger.ts:120-127). |
| 8 | INFO | — | Contract row "in-memory-spend-ledger.ts: vérifier le round-trip des champs optionnels" is not tested in this commit (the in-memory ledger stores the whole entry, `in-memory-spend-ledger.ts:60`). | W10's `metered-fetch.test.ts` covers window equality only. |
| 9 | INFO | integration test `read=undefined, creation=undefined` case | "Historical row" is simulated by `record()` writing explicit NULL/NULL, not by a raw INSERT that omits the columns. Column-level equivalent; literal pre-migration row not reproducible in-test. | — |

## Proven by reading (clean)

Contract conformity — absent = unknown, 0 = measured:
- Write path `postgres-spend-ledger.ts:213-214`: `${metered?.cache?.read ?? null}`, `${metered?.cache?.creation ?? null}`. `??` maps only `undefined`/`null` to NULL; `0` survives. UNMETERED entry → `metered === null` → NULL/NULL, which satisfies `spend_ledger_cache_usage_check`. METERED with no cache → NULL/NULL, allowed (the CHECK only constrains non-METERED rows).
- `toObservation` (`:120-127`): `...(row.cache_read != null || row.cache_creation != null ? { cache: { ...(row.cache_read != null ? { read: count(row.cache_read) } : {}), ... } } : {})`. Builds `cache` only when at least one counter is known, includes only known keys, never emits `{ cache: {} }`, no `?? 0`. `count()` = `Number()`, applied only to non-null values (bigint arrives as string from postgres-js).
- `listForMission` (`:278-279`): `cacheRead: row.cache_read == null ? null : count(row.cache_read)` — NULL preserved. `MissionSpendRow` (`:314-315`): `number | null`.
- `mission-trace.ts:440`: `cache read=${e.cacheRead ?? "unknown"} creation=${e.cacheCreation ?? "unknown"}` — `??` does not coalesce `0`, so a measured zero prints `0`; `null` prints `unknown`. Test `mission-trace.test.ts` asserts both `cache read=0 creation=5` and `cache read=unknown creation=unknown`.
- Budgets unchanged / no double counting: `spend.ts:85-135` `accumulate` reads only `promptTokens/completionTokens/totalTokens` (no `cache` reference anywhere in `spend.ts`); cache columns are never added to totals. Unit test asserts `windowFor` equality with a split-less ledger and `checkBudget → ALLOW` for all 9 combinations; `keeps UNMETERED unknown and UNPRICED measured` asserts `unmeteredCalls 1, unpricedCalls 1, totalTokens 10`.
- Schema `schema.ts:1341-1343`: `bigint(..., { mode: "number" })`, nullable, no `.default()`. CHECKs (`:1353-1358`) mirror the SQL exactly.

Migration data safety (my analysis, which the file itself should carry):
- `ADD COLUMN bigint` nullable, no default → catalog-only, no rewrite of existing rows.
- `cache_read >= 0` / `cache_creation >= 0` on existing rows: value NULL → predicate NULL → CHECK passes.
- `usage_kind = 'METERED' OR (cache_read IS NULL AND cache_creation IS NULL)` on existing UNMETERED rows: `FALSE OR (TRUE AND TRUE)` = TRUE; on METERED rows TRUE. Every existing row passes; the ALTER cannot fail on existing data.
- The append-only trigger (`BEFORE UPDATE OR DELETE ... FOR EACH ROW`) is not fired by ALTER TABLE.
- Consistency with the writer: UNMETERED rows are written NULL/NULL (above) → never violate `cache_usage_check`; METERED rows with cache absent are NULL/NULL → allowed. No existing write path breaks. A caller handing a negative counter would be refused by the DB (desired; `usage.ts` already turns such values UNMETERED upstream).
- Single ALTER statement → atomic. Lock: ACCESS EXCLUSIVE for the CHECK validation scan; table is small.
- Rollback (contract: keep the columns, never drop data): `DROP CONSTRAINT IF EXISTS` for the three new constraints; columns stay.

Journal / ledger rules:
- `_journal.json`: new entry `idx 61` directly after `0064` (`idx 60`), `when 1791232017287 > 1791232016287`, `tag` = SQL filename, `version "7"`, `breakpoints true`. Satisfies `migration-journal.test.ts` (bijection files↔tags, contiguous idx, strictly increasing `when`, unique 4-digit prefix).
- Prefix collision scan over every local/remote ref: `0065_*` exists only on `feat/fable-n1-w9-cache-ledger`. (0061 is absent on all refs — pre-existing gap, not this commit.)
- `migrations-fresh-database.integration.test.ts:14,39` derives the expected count from the journal; no hard-coded count to bump.
- `scripts/verify-migration-ledger.ts` is a read-only hash/`when` comparison; unaffected by the commit, but the live ledger will need the new row once 0065 is applied.

Tenant isolation:
- INSERT carries `${this.tenantId}`; `windowFor` `where tenant_id = ${this.tenantId}` (`:230`); `listForMission` `where tenant_id = ${this.tenantId}` (`:257`). Integration test asserts `ledger(OTHER_TENANT).listForMission("cache-mission")).entries` is `[]`; unit test asserts the mission SELECT contains `"where tenant_id ="`. Constructor still refuses an empty tenant.

Parameterisation:
- All new values go through the drizzle `sql` template (`${...}`); the only `sql.raw` is the pre-existing test helper with literal column names.

Scope:
- 9 files: ledger + its two tests, reservations test (test only, no production change), `schema.ts`, migration + journal, `mission-trace.ts` + new test. Every one is named in the contract's W9 rows. Nothing out of scope; `contracts.ts`, `usage.ts`, `metered-fetch.ts` (W10) untouched.

## Not proven

- That any test in the commit passes (unit or integration): no run output anywhere; reviewer did not execute.
- Durability on PostgreSQL: NULL/0/positive round-trip, the three CHECKs, historical NULL preservation — written, not executed (finding 1).
- Settlement path on a real DB (finding 6).
- In-memory ledger round-trip (finding 8).
- TypeScript compilation of the new integration test (`rows.map` on the raw `execute` result without the cast the neighbouring tests use) — should be fine with the postgres-js `RowList` type, but unverified.
- Owner authorisation for creating the migration (finding 3).

## Summary

6daef30 implements the W9 half of the cache contract correctly: two independent nullable `bigint` columns with no default, an INSERT that writes `?? null` (never `?? 0`), reconstruction and `listForMission` that keep NULL as `null` and only build a `cache` object from known counters, a trace that prints `unknown` per counter and announces no aggregate cache total, CHECKs that forbid negatives and cache values on UNMETERED rows without touching the existing total constraints, tenant predicates on every query, and budgets provably unchanged because `accumulate` never reads `cache`. The journal entry is well-formed and the 0065 prefix is free on every ref. What is missing is the evidence the contract and CLAUDE.md demand — the integration tests are marked "Prepared only" and no run is attached — and the migration file lacks the data-safety/rollback header and idempotency guard that every sibling migration carries and that the ICOS database rule requires; the migration's creation also needs the owner's distinct authorisation the contract called for. Requested changes: (a) run `pnpm test:integration` (or the two budget integration files) on a disposable DB after 0065 and attach the output; (b) add DATA SAFETY / ROLLBACK sections and an existence guard to 0065; (c) fix the misleading "never target the shared test database" comment and the "migration 0055" title; (d) optionally add a per-counter coverage line to the trace total.
