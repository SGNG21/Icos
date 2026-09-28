# 0043: D1 was never an auth defect — one leaked lifecycle wearing three failures

## Status
Accepted

## Context

Three `auth-bootstrap-cli.integration.test.ts` tests had failed by 60-second timeout since
`716c6b8` first made the Docker-gated suites runnable. They were tracked as D1 for six
milestones, always described as "pre-existing, not caused by this milestone, count has never
moved", and they blocked final certification.

They were never investigated, because the count never changed and every milestone could
correctly show it had not touched `src/server/auth/`.

## Root cause

Reproduced deterministically by running the CLI directly:

```
owner_already_present      <- the work SUCCEEDS
...then the process never exits
```

The bootstrap completed, printed its result and set its exit code. The process then hung,
so `execFile` never resolved and the test waited out its timeout.

`process._getActiveHandles()` after `container.close()` showed three live sockets, one
explicitly to `:5432`.

`buildPostgresContainer` opens **three** PostgreSQL clients:

1. the shared drizzle handle;
2. `PostgresWorkspaceRegistry` — its own `postgres.js` client;
3. `PostgresGit` — its own client, connected outside the drizzle schema.

`close` was `handle.close`. Both other pools — each already having a working `close()` that
nobody called — outlived it and kept the Node event loop alive.

For a long-lived server that is invisible: the process is meant to stay up. For a **CLI** it
is fatal. The defect was introduced with the Phase 8D workspace manager and only ever
manifested in the one place that spawns a short-lived Node process and waits for it.

## Decision

`close()` closes every client the container opened, using `Promise.allSettled` so that one
client refusing to close cannot leave the others open, and rethrowing the first failure so a
genuine close error is not swallowed.

**Nothing was skipped, quarantined, or given a longer timeout.** The 60-second limit is
correct and unchanged — a bootstrap CLI that takes a minute *is* broken. The tests now pass
in 10.7s.

## Consequences

- Integration failures: **0**. The only remaining skips are the opt-in live Hermes proofs.
- The full integration suite dropped from ~290s to ~107s, because three 60s timeouts and a
  set of leaked connections are gone.
- Any future component that opens a connection and forgets to close it is now caught by a
  regression test that counts real backends in `pg_stat_activity`, rather than asserting on
  internals it would have to be updated to know about.

## Evidence

- Deterministic reproduction: the CLI hung >45s in a direct run; after the fix it exits in
  0.7s with the correct output.
- `MUTATION`: restoring `close` to the handle alone reproduces D1 **exactly** — all three
  auth-bootstrap-cli tests time out at 60s again, and the new lifecycle test fails.
- New regression proofs: the container returns to its baseline backend count after `close()`,
  and `close()` is idempotent (shutdown paths run twice: signal + explicit stop).
- typecheck PASS, build PASS, lint 0 errors / 289 warnings (= baseline), `git diff --check`
  PASS, unit 1788 PASS, integration **443 passed / 0 failed / 2 skipped**.

## The lesson worth keeping

A failure that is stable is not thereby understood. "Pre-existing, count unchanged, not my
milestone" was true every time it was written, and it let a one-line lifecycle bug survive
six milestones and block certification. The first genuinely useful question was not "whose
change caused this?" but "what is the process actually doing when it times out?" — and the
answer took one direct run.
