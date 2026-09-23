# Database migrations — integrity strategy (Phase 6.1)

## Rule
`drizzle/meta/_journal.json` is the single source of truth. A fresh PostgreSQL database must be
reproducible from zero with `drizzle-orm` `migrate()`, and must match `src/server/database/schema.ts`.
Applied history is **never edited in place**: fixes are new forward, idempotent migrations.

## Audit (2026-09-19)
| Item | Finding | Decision |
|---|---|---|
| `0008_missions.sql` | Duplicate of journaled `0008_tiny_serpent_society`; never journaled; no effect on a fresh DB | removed |
| `0014_add_task_id_to_actions.sql` | Never journaled; no effect on the resulting schema | removed |
| `0015_add_columns_to_agents.sql` | Never journaled; would re-add columns already created by `0000` | removed |
| `0028/0029_add_superseded_*` | Real changes (`superseded` status) but never journaled, so a fresh DB lacked them | replaced by journaled `0028_schema_parity_superseded` |
| In-place edit of `0000` | Changed applied history: renamed `approvals.decided_by_label` to `decided_by` (wrong vs `schema.ts`), added defaults, and hid a missing `approvals.created_at` migration | `0000` restored byte for byte; the real deltas live in `0028` |

`0028_schema_parity_superseded` (idempotent): `superseded` on `tasks`/`mission_tasks`, `approvals.created_at`,
conditional rename `decided_by -> decided_by_label`, `created_at DEFAULT now()` on `actions`/`approvals`/`tasks`.
`0029_qc_review_unavailable_wakeup_outbox`: `quality_control_jobs.review_unavailable` state and `wakeup_pending` outbox.
`0035_learned_patterns_factual`: aligns the historical `learned_patterns` physical names and lookup indexes with
`schema.ts`, then removes only its obsolete synthetic `confidence` column/index; factual observations and all
other `learned_patterns` data remain unchanged.

## Verification
- `src/server/database/migration-journal.test.ts` — journal <-> SQL files bijection, contiguous idx, increasing `when`.
- `src/server/database/migrations-fresh-database.integration.test.ts` — creates a blank `icos_migcheck_test`,
  runs `runMigrations`, asserts applied count, `superseded`, `approvals` columns and the Phase 6 tables.
- Manual proof (2026-09-19): schema of a blank database vs the live database is identical except the intended
  `approvals.decided_by_label` (live had the wrong `decided_by`).

## Live database `icos_n23_probe`
Its `__drizzle_migrations` bookkeeping (20 rows) predates several manual changes and is not aligned with the
journal; **do not run `migrate()` against it**. `0028` and `0029` were applied by hand (`psql -f`, both idempotent,
after a full `pg_dump`). To converge a new environment, build it from zero instead.

## Test databases
Tests never touch the live database: `createDatabase` refuses any database whose name lacks a `test` token
(or contains `probe|live|prod`) when running under Vitest. `pnpm test:db:setup` creates/migrates `icos_test`;
`pnpm test` excludes `*.integration.test.ts`; `pnpm test:integration` runs them against `icos_test` only.
