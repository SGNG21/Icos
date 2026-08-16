# COMMIT_MAP_49 — main..feat/cockpit-real-wiring-1 (Phase 1 review)

Date: 2026-08-15. Range: `main (7e2ea80)..feat/cockpit-real-wiring-1 (ba610ca)`.
Ancestry verified: merge-base `7e2ea80125139c0546be7184b9f2b0484165da7c` = main exactly; `git merge-base --is-ancestor main candidate` = true; `rev-list --left-right --count` = **0 behind / 49 ahead** → pure fast-forward candidate.
Topology: 49 commits, exactly **1 merge commit** (`9211851`, second parent = main itself — the point where the supervisor lineage absorbed the approved G1.0 baseline). Everything else is single-parent. No history rewrite indicators.

## Groups (oldest → newest)

### A. Supervisor/Worker foundation — SUP-0..7 (8 commits, 2026-07-26)
| # | SHA | Subject |
|---|---|---|
| 1 | 392e7c5 | SUP-0 — Supervisor/Worker architecture design |
| 2 | 4eee1aa | SUP-1 — Task DAG + Scheduler |
| 3 | 7c2109c | SUP-2 — Local Worker Manager |
| 4 | ce811cc | SUP-3 — Worktree / Git Manager |
| 5 | 5aecde8 | SUP-4 — Review / Correction Loop |
| 6 | 1425393 | SUP-5 — Integration + Global Gates |
| 7 | 387e520 | SUP-6 — Preview Delivery |
| 8 | 3c2d178 | chore: checkpoint SUP-7 before G1 baseline reconciliation |

### B. G1 baseline reconciliation (3 commits)
| # | SHA | Subject | Note |
|---|---|---|---|
| 9 | 9211851 | fix(supervisor): reconcile with canonical G1 baseline | **MERGE commit** (parents `3c2d178` + `7e2ea80`=main). Touches only `src/server/g1/` (+173/−23, brings reviewed G1 fixes into lineage) |
| 10 | bc164f3 | fix(supervisor): reconcile with canonical G1 baseline | **Same subject, different content** — supervisor test-fixture fixes against canonical G1 contracts (11 files). Not a duplicate; disjoint file sets. Cosmetic issue only: identical message |
| 11 | 5676986 | fix(supervisor): close reconciliation lint gate | |

### C. Context↔Supervisor bridge (5 commits, 2026-07-27)
12 `2a880d7` ctx-sup-1a core contracts · 13 `2fc6fbd` persist versioned mission context (**rebase-twin of `bd97dae` on feat/ctx-sup-1 — identical patch-id**) · 14 `9c89c5a` bridge context to supervisor · 15 `bb87af7` bridge + precedence + E2E · 16 `6bad007` wire contextual input into live supervisor

### D. Autonomous-workflow integration admin (3 commits)
17 `63bab46` / 18 `c8aa5ca` / 19 `ceae0d7` — "integration: merge <prev>" subjects but **single-parent** commits produced by the autonomous integration loop (self-referencing chain). Admin/mechanical; content verified additive.

### E. D1 identity + autonomous hardening (7 commits)
20 `232fc67` SystemAgent identity type (adds `"system"` to `PolicyActor.kind`) · 21 `5ce77b4` propagate D1 scoped identity · 22 `182c76f` **admin**: remove accidentally tracked embedded worktree repos · 23 `11a84e4` AUTH-05 test-expectation fix (missing authorizationLevel **denies** — strengthens default-deny) · 24 `9d1783c` stale worktree collision · 25 `0467985` harden worker result handling · 26 `260af18` + 27 `c5167d4` global-gates determinism / node finalization

### F. Capability/self-state/mission surface (3 commits, all rebase-twins)
28 `b27e1f7` capabilities (**twin of `4272392`**) · 29 `05776f3` self-state (**twin of `ded591f`**) · 30 `327939b` governed user mission entry (**twin of `f074426`**) — all identical patch-ids vs their standalone branches.

### G. Cockpit V1 (11 commits; note dates 2026-07-26 — see ordering)
31 `c38fdb1` design spec · 32-40 `1556cc3` statusConfig, `2cdf2a3` format, `b38269a` types, `fcd6f47` mocks, `85c36b4` mappers, `ea324fb` store, `646785e` cssClass fix, `67268c0` CSS, `6a87836` CPT-1 components · 41 `dc22ab7` usable mission supervision flow

### H. Bridge + runtime hardening (3 commits)
42 `62ec0ed` coordination record (admin) · 43 `94cf920` mission→task-DAG bridge · 44 `33c67d3` **harden local execution and worktree isolation** (fail-closed runtime adapter, canonical worktree validation, guarded branch deletion)

### I. Cockpit real wiring + OmniRoute (5 commits, 2026-07-29/30)
45 `90bff5b` real mission execution + job polling (**twin of `432cbaa`**) · 46 `b54d1af` OmniRoute capability evidence · 47 `12556d1` OmniRoute status health endpoint · 48 `676e371` route conversational requests safely · 49 `ba610ca` OmniRoute conversational streaming

## Duplicate / rebase-equivalent adjudication (all verified via `git patch-id --stable`)

| Pair (standalone branch vs in-spine) | Result |
|---|---|
| `ded591f` vs `05776f3` (self-state) | IDENTICAL patch-id → standalone redundant |
| `4272392` vs `b27e1f7` (capabilities) | IDENTICAL patch-id → standalone redundant |
| `f074426` vs `327939b` (user-mission) | IDENTICAL patch-id → standalone redundant |
| `432cbaa` vs `90bff5b` (cockpit real wiring) | IDENTICAL patch-id → standalone redundant |
| `bd97dae` vs `2fc6fbd` (ctx persistence) | IDENTICAL patch-id → standalone redundant |
| `a827c74` vs `33c67d3` (runtime safety) | verified byte-identical during RECON-001 |
| `9211851` vs `bc164f3` (same subject) | NOT duplicates — disjoint file sets, both legitimate |

## Experimental / admin commits
- Admin: `3c2d178` (checkpoint), `63bab46`/`c8aa5ca`/`ceae0d7` (integration loop), `182c76f` (untrack embedded repos), `62ec0ed` (coordination record). All benign; none reverts governance.
- No experimental dead-ends detected; every group lands in the final tree.

## Ordering observations
- Cockpit V1 commits carry author dates 2026-07-26 but sit after 2026-07-28 commits → the cockpit branch was **rebased/replayed into the spine** (consistent with `feat/cockpit-v1` chain twin noted in the reconciliation plan). Not a defect; explains date inversion.
- The only merge (`9211851`) merges main itself — fast-forwardability is unaffected (verified 0 behind).

## Conclusion (commit-map level)
The 49 commits form one coherent, phased narrative (foundation → reconciliation → context bridge → identity/hardening → surface → cockpit → runtime hardening → real wiring) with no foreign or contradictory content. Nothing at this level argues for SPLIT.
