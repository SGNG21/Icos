# ICOS Roadmap P0–P3 — RECONNAISSANCE-001

Date: 2026-08-15. Derived strictly from CURRENT_STATE / CAPABILITY_MAP / GAP_ANALYSIS / WORKTREE_RECONCILIATION_PLAN. Principle: preserve → integrate → govern → extend. No item may rebuild an existing capability (see CAPABILITY_MAP "DO NOT REBUILD").

## P0 — Preserve & stabilize (days; loss-risk removal; all reversible)

| # | Item | Gap | Evidence gate |
|---|---|---|---|
| P0.1 | Push all 19 unpushed local branches to origin (owner authorizes pushes) | G1 | `git ls-remote` shows each branch |
| P0.2 | Snapshot dirty worktrees as `wip/*` branches or stashes (icos-runtime-safety, icos-governance, icos-cockpit, icos-lead) | G7 | wip refs exist; `status --porcelain` risk removed |
| P0.3 | Rescue unique uncommitted specs (governance-reconciliation, d4-runtime-execution, cockpit-v1 plan) onto a docs branch | G7 | files committed |
| P0.4 | Repair worktree registration (`git worktree repair`), decide inside-root vs sibling layout; NEVER prune before repair | G2 | `git worktree list` shows zero `prunable` |
| P0.5 | Rotate the gateway token found in `.claude/settings.local.json`; remove it from the allowlist entry | G10 | new token issued; old revoked (owner attests) |
| P0.6 | Review + accept this audit; commit the six RECON-001 files | C1/C2 | owner merge |

## P1 — Integrate the built system (1–2 weeks; the value is already coded)

| # | Item | Gap | Evidence gate |
|---|---|---|---|
| P1.1 | Review & merge the linear spine `main..ba610ca` (supervisor/worker, DAG, ctx bridge, autonomous workflow, global gates, self-state, capability introspection, user-mission entry, cockpit V1+real, runtime safety) as reviewed PR(s) | G1 | `env -u NODE_ENV -u PERSISTENCE pnpm check` green on tip; PR review record |
| P1.2 | Re-base governance bootstrap (`0352fab`+`9efaf1a`) onto new main, dropping duplicate skill commit; merge | G4 | PR merged; CLAUDE.md active on main |
| P1.3 | Write `docs/icos/constitution/ICOS_CONSTITUTION.md` (or formally amend CLAUDE.md if the constitution lives elsewhere) — resolves contradiction C1 by owner decision, not silently | G3 | file exists or CLAUDE.md amended via decision |
| P1.4 | Establish `.icos/tasks/` as the Task Contract home (schema already exists); record DEC evidence pointers for DEC-0001..0010 | G3 | first contracts validated against `task-contract.schema.json` |
| P1.5 | Backfill decision records for merged architecture lots (D1–D4, G1.0, C2, tenant) — either ADRs in `docs/decisions/` or a decision declaring `docs/superpowers/specs/` canonical (resolve G5 explicitly) | G5 | decision merged |
| P1.6 | Pin test environment in vitest config (neutralize ambient NODE_ENV/PERSISTENCE) | G9 | plain `pnpm test` green regardless of shell env |

## P2 — Govern & harden (2–4 weeks)

| # | Item | Gap | Evidence gate |
|---|---|---|---|
| P2.1 | Duplicate adjudication (Phase 3 of reconciliation plan): diff and retire `feat/self-state-1`, `feat/capability-introspection-1`, `feat/user-mission-entry-1`, `feat/cockpit-v1`, `feat/ctx-sup-1`, `review/*` twins | G6 | diff evidence per pair; archive tags created |
| P2.2 | Rebase + merge `feat/voice-v0` onto integrated main | G11 | PR green |
| P2.3 | Minimal CI: `pnpm check` + unit tests on PRs; wire REL-001 gates (tests, security gate, evidence bundle) to the merged global-gates machinery | G8 | first CI run on a PR |
| P2.4 | Evaluate the ~50-line `worktree-manager` dirty delta and `icos-governance` dirty code vs main; merge or discard with sign-off | G7 | decision recorded |
| P2.5 | Integration tests with Docker/Postgres executed and recorded for the merged spine (`pnpm test:integration`) | quality rule | run log attached to PR |

## P3 — Clean up & extend (after P1/P2 stable)

| # | Item | Gap | Evidence gate |
|---|---|---|---|
| P3.1 | Archive-tag and remove redundant worktrees/branches (`git worktree remove`, never bare prune) per reconciliation Phase 4 — each removal owner-approved (irreversible) | G2/G6 | tags exist before every deletion |
| P3.2 | Align `docs/roadmap/initial-roadmap.md` and `docs/architecture/future/*` with post-integration reality (several "future" lots are now merged) | doc drift | updated docs PR |
| P3.3 | Resume feature work from the integrated base: next candidate lots per `docs/architecture/future/04-lot-sequence.md` (e.g. G1.x beyond foundation, RAG/memory per DEC-0008, local-compute routing per DEC-0009/AI-DATA-001) | — | new Task Contracts in `.icos/tasks/` |
| P3.4 | Multi-tenant enforcement depth (RLS strategy per DEC-0003, database rule) before any real tenant data | security | tenant review via `tenant-security-review` skill |

## Sequencing rationale

P0 removes single-machine loss risk before anything else touches git state. P1 merges the already-built execution layer instead of rebuilding it (largest value for near-zero new code), and closes the governance contradictions by explicit owner decisions. P2 pays the reconciliation/CI debt while the merge context is fresh. P3 deletes only what has an archive tag and extends only from the reconciled base.
