# ICOS release cutover on the VPS — atomic, reversible, owner-gated

Everything here is **prepared, not applied**. The cutover restarts `icos-web` and migrates the live
database: both need the owner's explicit go. Each step has its rollback and its proof.

## Layout

```
/srv/icos/releases/<sha>/        immutable export of ONE commit (git archive), built, deps installed
/srv/icos/releases/<sha>/RELEASE_SHA
/srv/icos/current -> /srv/icos/releases/<sha>      the only thing the cutover changes
/etc/systemd/system/icos-web.service.d/10-release.conf   WorkingDirectory=/srv/icos/current
```

The live tree today is `/srv/icos/worktrees/vps-deploy` (a git worktree: audit risk R4). The first
cutover also registers it as a release so the rollback is the same symlink flip:
`/srv/icos/releases/049a7d9-vps-deploy -> /srv/icos/worktrees/vps-deploy`.

## Scripts (`deploy/vps/release/bin`)

| Script                   | Does                                                                                                                                                                                                                                        | Touches production |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `build-release.sh <sha>` | `git archive` → `/srv/icos/releases/<sha>`, `pnpm install --frozen-lockfile --offline`, `pnpm build`, writes `RELEASE_SHA`                                                                                                                  | no                 |
| `preflight.sh <sha>`     | PASS/FAIL report: build present, deps present, migrations pending vs live journal (read-only), backup kit present, OmniRoute reachable, env keys required by the release present in `icos.env` (names only)                                 | no (reads)         |
| `health-check.sh [port]` | `/login` 200, `/api/cockpit` 401 without session, `RELEASE_SHA` served tree, journal free of `Error` in the last minute                                                                                                                     | no (reads)         |
| `cutover.sh <sha>`       | **owner only**: backup → drop-in → symlink flip → `db:migrate` (3 additive migrations) → `systemctl restart icos-web` → health-check; aborts before any step whose precondition fails                                                       | **yes**            |
| `rollback.sh`            | **owner only**: symlink back to the previous release → restart → health-check. The three migrations are additive (new column, widened CHECK constraints): the old code runs on the migrated schema, so rollback does not touch the database | **yes**            |

## Sequence (one authorization covers it, see the runbook)

1. `preflight.sh <sha>` → all PASS (attach the report).
2. `cutover.sh <sha>` — ~60 s of unavailability (Next.js start). Watch `journalctl -u icos-web -f`.
3. `health-check.sh` → PASS, then the voice E2E harness (owner, needs the password) and
   `icos-sovereignty-check.sh`.
4. Not happy → `rollback.sh` (same ~60 s).

## Why the database step is safe to roll back

`0062` adds a nullable column and two CHECK constraints on `workers`, and widens the
`audit_entries.event_type` CHECK; `0063` widens that CHECK again; `0064` widens
`scheduled_jobs.kind`. Rehearsed on a clone of the live base (2026-10-11, see the preflight
report): all existing rows satisfy the new constraints, the old code never reads the new column.
A rollback therefore keeps the migrated schema; nothing is dropped.
