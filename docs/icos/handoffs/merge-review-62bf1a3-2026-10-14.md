# Independent review — merge ffc6300 + port 62bf1a3 on feat/fable-5-1-convergence

Reviewer: Claude (Fable 5.1), independent of the supervisor who performed the merge. Strictly read-only: `git log/show/diff/diff-tree/merge-base/rev-list/ls-tree/grep`, `diff`, `sha256sum`, one `python3 -I` JSON parse of `git show` output. No edit, no git write, no test executed, no file of the worktree touched (the only writes are two `git show` dumps and this report in the session scratchpad).
Worktree HEAD at review time: `62bf1a3` on `feat/fable-5-1-convergence`.

## Verdict: APPROVE

The merge is byte-clean in both directions, the port is a byte-exact copy of the approved recipe with zero deletions, the drizzle journal and 0065 are exactly the lane's, and no consumer on the merged tree references a symbol the lane renamed or removed (none was). No finding blocks.

## 1. Merge ffc6300 — topology and content

```
$ git log --oneline 8e25920..ffc6300
ffc6300 Merge branch 'feat/fable-n1-w9-cache-ledger' into feat/fable-5-1-convergence
4c09f42 docs(w9): first install of 0065 and header rollback proven on a fresh database
8e4f844 fix(w9): migration 0065 states data safety, rollback and is idempotent
e6e4970 docs(w9): certify cache ledger on isolated PostgreSQL
c6b6ae3 test(w9): verify lease renewal against PostgreSQL deadline
6daef30 feat(w9): persist and report independent cache counters
fd09189 fix(w10): preserve cache usage split and metering
$ git merge-base 8e25920 4c09f42         -> 794b6ea41153da0e7549acb3d123480b2dc8df3a
$ git rev-list --parents -n1 ffc6300      -> ffc6300 8e25920 4c09f42
```
Exactly the 6 lane commits + the merge; parents are the two expected heads; base is 794b6ea.

Clean-merge proofs:
- `git diff 8e25920 ffc6300 --stat` and `git diff 794b6ea 4c09f42 --stat` are identical (17 files, 1135 insertions, 38 deletions); `diff <(git diff 794b6ea 4c09f42) <(git diff 8e25920 ffc6300)` -> `IDENTICAL_PATCHES` (full patch bodies, not just stats).
- `git diff-tree --cc ffc6300` prints only the commit id (1 line): the combined diff is empty, i.e. no file in the merge differs from both parents — no resolution edit.
- Other direction: `git diff 4c09f42 ffc6300 --stat` = `integration-gate.ts | 10 +`, `sandboxed-command-runner.test.ts | 3 +` and `diff <(git diff 794b6ea 8e25920) <(git diff 4c09f42 ffc6300)` -> `IDENTICAL_PATCHES`. So on top of the lane the merge adds exactly what 8e25920 added vs the base: the `NODE_ENV: "test"` overlay hunk in `IntegrationGate` plus `"NODE_ENV"` in the sorted key list, its comment, and `expect(call.env.NODE_ENV).toBe("test")`. Nothing from the lane is lost.
- `comm -12` of the two sides' touched-file lists is empty: the 17 lane files and the 2 convergence files are disjoint, which is why the merge could not need resolution.
- `git grep` for conflict markers on `62bf1a3 -- src drizzle`: none.

## 2. Port 62bf1a3

```
$ git show 62bf1a3 --numstat --format=
67	0	src/server/workspace-manager/sandboxed-command-runner.test.ts
$ git diff ffc6300 62bf1a3 | grep -c '^-[^-]'   -> 0
```
One file, 67 insertions, 0 deletions. Parent is ffc6300.

The 67 lines are: 1 import + 1 blank separator + the 65-line block.
- Import: `import { childEnvironment } from "@/server/workers/process/child-environment";` — `diff` against line 13 of `77746ec:…test.ts` -> `IMPORT_IDENTICAL`. Target exists on the merged tree (`git ls-tree 62bf1a3 src/server/workers/process/child-environment.ts` -> blob b20239c) and exports `childEnvironment` (line 92); `@/*` -> `./src/*` in tsconfig.
- Block: `diff <(git show 77746ec:F | sed -n '225,289p') <(git show 62bf1a3:F | sed -n '231,295p')` -> `BLOCK_IDENTICAL`; sha256 of both extracts `8f81e6d37511ca1bb5b120fefd0a40d7faea3784fb959822816dbd17b641a6bc`. The block sits before the `describe`'s closing `});` (now line 296), exactly as the recipe says.
- Existing assertion block untouched: `diff <(git show ffc6300:F | sed -n '195,228p') <(git show 62bf1a3:F | sed -n '196,229p')` -> `ASSERTION_BLOCK_UNTOUCHED`. At 62bf1a3 lines 205–229 still carry `storeDir`, the sorted key list with `"CI"`, `"NODE_ENV"`, `npm_config_verify_deps_before_run`, `pnpm_config_verify_deps_before_run`, the pnpm trust/frozen/store keys, `expect(call.env.pnpm_config_store_dir).toBe(storeDir)`, `expect(call.env.NODE_ENV).toBe("test")`, canary and `expect(call.network).toBe(false)`. Since the patch has zero deletions, every line of ffc6300's file survives verbatim.
- No `integration-gate.ts` hunk ported (correct: 8e25920 already carries it; 77746ec's version would have duplicated it).
- Helper symbols the block uses exist in the file at 62bf1a3: `ok` (:29), `FakeProvisioner` (import :21), `APPROVED` (:299), `prepare` (:304), `CANARY` (used by the existing test), `IntegrationGate`, `SandboxedCommandRunner`, `WorkspaceManager`, `InMemoryWorkspaceRegistry`, `Git`, `NonInteractiveProcessSpec`.

This matches the recipe in `docs/icos/handoffs/p0-nodeenv-test-review-77746ec-2026-10-14.md` to the letter (import :13 + :225–289 only; keep :204–227 of 8e25920; no block diff 8e25920->77746ec).

Not re-verified here (out of scope, no test run): the commit message's "14/14 (3 new), eslint/prettier clean".

## 3. drizzle journal and 0065 at 62bf1a3

```
count 62 ; last = {'idx': 61, 'version': '7', 'when': 1791232017287, 'tag': '0065_spend_ledger_cache', 'breakpoints': True}
prev  = {'idx': 60, 'when': 1791232016287, 'tag': '0064_scheduler_reconcile_compute_fleet'}
last.when > prev.when : True ; idx contiguous 0..61 : True ; duplicate tags : False ; when strictly increasing overall : True
```
`git diff 8e25920 62bf1a3 -- drizzle/meta/_journal.json` is the single 7-line entry append (idx 61) — the journal at 8e25920 ended at idx 60 / 0064, so no idx collision from the convergence side.

`drizzle/0065_spend_ledger_cache.sql`: blob `9105c13761e70a33e94eb06e4a0dfeb2cb51371e` at both `4c09f42` and `62bf1a3` (`diff` -> `SQL_IDENTICAL`); sha256 `e5ea3bd007814e487df2bb0106e1ae0f6a318654865298c0d0951d25b1cdae2d` at 8e4f844, 4c09f42 and 62bf1a3 — the same hash the W9 second-pass review verified and the certification report says was replayed. `git diff 8e4f844 4c09f42 --stat` = the certification report only (+114), so the approved code is what was merged, and 4c09f42 closes the review's N1 gap (first install on a fresh DB) by evidence, not by code change. `git ls-tree 62bf1a3 drizzle/` ends `…0063, 0064, 0065_spend_ledger_cache.sql, meta`.

## 4. Static consumer check on the merged tree (62bf1a3)

Export surface of the six lane-touched source files (`git diff 794b6ea 4c09f42 -- contracts.ts usage.ts metered-fetch.ts postgres-spend-ledger.ts schema.ts mission-trace.ts`): no export removed or renamed. Changes are:
- `TokenUsage.cache` fields become optional (`read?`, `creation?`) in `src/core/budget/contracts.ts`.
- `MissionSpendRow` gains two required fields `cacheRead`, `cacheCreation` (`postgres-spend-ledger.ts:311-312`); `toObservation` and `record()`/`windowFor()`/mission query carry the two columns.
- `schema.ts`: two nullable bigint columns + three CHECKs on `spendLedger` (additive).
- `metered-fetch.ts`: new private `logUsageSplit`; now reads `settlement.attributedTo` from `reservations.settle()`.
- `mission-trace.ts`: per-row cache fields and the coverage line (additive formatting).

Consumer sweep:
- `git grep -E '\.cache\.(read|creation)|cache\?\.(read|creation)|cacheRead|cacheCreation|cache:\s*\{' 62bf1a3 -- src/**` minus the lane-touched files: no hit. The only `cache` mentions in untouched budget/pricing modules (`src/core/pricing/registry.ts:64,229`) are comments. So no untouched code relies on `cache.read`/`cache.creation` being a `number`.
- `MissionSpendRow` is produced only inside `postgres-spend-ledger.ts` (:302 def, :324 `MissionSpendEntry`, :327 `entries`); no other producer that would miss the two new required fields.
- `settle()` on `ports.ts:115-125` returns `Promise<SettlementOutcome>` whose `attributedTo: Attribution | null` (`ports.ts:91`) already existed at base 794b6ea and is populated in `postgres-spend-reservations.ts:259`. The W10 commit's new read is type-safe against the unchanged port.
- Importers of the six modules (31 files, incl. `scripts/mission-trace.ts`, `metered-egress-proxy.ts`, `quality-control-service.ts`, `in-memory-spend-ledger.ts`, `compose-spend.ts`) import only symbols that still exist (no rename happened); none touches the changed `cache` shape.

Static only; `pnpm typecheck` was not run here (other tasks are running tests in this worktree). The W9 certification states typecheck/369 tests passed at 8e4f844 on the lane, and the merge adds only 8e25920's disjoint 13 lines plus the 67-line test port.

## Findings

| # | Severity | Finding |
|---|----------|---------|
| — | none | No resolution edit, no lost hunk, no byte deviation in the port, no deletion, journal/migration exact, no dangling symbol. |
| I1 | INFO | Not re-executed: 62bf1a3's claimed 14/14 on `sandboxed-command-runner.test.ts` and lint/prettier; and the merged tree's typecheck. Expected to pass by construction (disjoint files, additive types, port byte-identical to a commit whose test the P0 review deduced non-tautological). Owner's running test pass will settle it. |
| I2 | INFO | The W9 review's open item (e) — owner confirmation of the migration authorisation — is unchanged by this merge; 0065 is in the tree but applying it to the live DB remains a release decision. |
