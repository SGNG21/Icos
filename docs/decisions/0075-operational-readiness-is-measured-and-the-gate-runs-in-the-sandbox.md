# 0075: Operational readiness is measured, and the integration gate runs in the worker sandbox

## Status

Accepted on `feat/p0-autonomy-unblock` (P0 autonomy unblock, 2026-10-11). Extends 0062 (self-model
is measured), 0064 (fleet reconciliation, amended by W1), 0058/0059 (Tool Gateway), 0063 (client
context, amendment A) and completes ADR 0073 on this line. The pre-dispatch risk gate is its own
decision, 0074.

## Context

The live runtime reported `mission.execute = GOVERNED`, `workforce.delegate = DEGRADED`,
`compute.providers = DEGRADED`, `tools.governed = NOT_CONNECTED`, and could not resolve
« LDS Rénov ». A factual audit showed that every status was runtime-backed — none was mocked — but
that several probes measured the wrong thing, one capability could never exceed GOVERNED by
construction, and one security property had been silently re-opened:

1. **The integration gate ran worker-authored code unconfined, with the server's secrets.**
   `typecheck`/`lint`/`test`/`build`/`test:integration` execute the worker's tests, configs and
   package scripts. The gate launched them with `execFile` and `{ ...process.env }` minus three
   database variables. The worker itself was confined (verrou C8, ADR 0073); the gate re-opened
   everything one step later on the same code.
2. **ADR 0073 was half-integrated.** The sandbox side (no writable gitdir for a worker) was merged
   (6d30ce5) without the trusted finalization (7b3bcc2, left on `cert/adr0073-materialization`).
   No governed write could become a commit: the gate refused every one with `GATE_PRECONDITION`,
   and the full autonomous chain could not complete.
3. **Fleet probes counted rows, not resources.** Disabled, provider-withdrawn and credential-less
   workers stayed in the denominator forever; the reason a probe failed was thrown away. DEGRADED
   was permanent and undiagnosable.
4. **Tool probes counted declarations.** Revoked and expired grants, DISABLED/AUTH_FAILED health
   rows and executors denied by the allowlist all counted; no production code called the gateway.
5. **Scheduler liveness was inferred from `NODE_ENV`/`PERSISTENCE`**, not measured.
6. **The client directory had a single, manual writer**, so the live directory was most likely
   empty and every client reference fell through to a clarification.

## Decision

1. **The gate runs every verification command through `runNonInteractive`** — the runner workers
   use — via `SandboxedCommandRunner`: environment constructed by the gate (test database URL, CI,
   verify-deps off) with `envPassthrough: []`; disk limited to the worktree and a disposable HOME
   (read-write) plus the pnpm store (read-only, never HOME or an ancestor); network denied by the
   OS except for the PostgreSQL step; confinement REQUIRED (no backend, or an unconfined result, is
   a FAIL). Both `execFile` runners are removed.
2. **ADR 0073's finalization is merged** on this line: a worker writes files; ICOS revalidates
   lease, fencing and scope and materializes the commit.
3. **Three capability states**, each with a definition the probes enforce:
   - `READY`: every active, configured resource behind the capability is measured operational now.
   - `PARTIAL`: operational, with a NAMED part not configured (e.g. a provider with no credential in
     the router). Nothing configured is failing; the evidence names what to set.
   - `AUTONOMOUS_BY_POLICY`: mission execution with the 0074 risk gate composed. Without the gate,
     GOVERNED.
   DEGRADED keeps its meaning: something configured is down.
4. **Every probe reads live state**: fleet by the canonical eligibility rules (one read per turn
   feeds workers, routable and per-provider health); live grants and dispatchable, unexpired
   connectors only; executors only when allowed and a sandbox backend works; scheduler liveness
   from `scheduled_jobs` (a completion within 3 minutes, or a live lease); realtime requires a live
   owner grant for the runtime identity and a composed caller.
5. **New facts** `context.scope` (resolver composed + client directory size) and
   `knowledge.routing` (sources composed; stage-weighted keyword selection within a budget, filtered
   by client/project — no semantic routing is claimed).

## Consequences

- A grant is still never implicit (0058). `external.realtime` and connector-based
  `tools.governed` reach READY in production only after the owner runs `pnpm tools:grant-realtime`
  (or the grants route); until then they report NOT_CONFIGURED/NOT_CONNECTED, naming the command.
- ~~The gate's PostgreSQL step has full network (no backend filters by host).~~ Superseded by
  amendment H1 below: no gate step has the network.
- Test suites that the gate runs may not depend on Git (the gitdir is not mounted, by ADR 0073);
  one test was rewritten to read the tree from disk.
- `PARTIAL` is a new tone in the cockpit (`warn`), distinct from `DEGRADED`.

## Amendment H1 (2026-10-11): the PostgreSQL step reaches only a disposable database

**Residual risk H1.** Decision 1 left one hole: the PostgreSQL step ran with `network: true` and
the shared test-cluster URL. Worker-authored tests therefore shared the host network namespace —
every loopback service (model router, Temporal, other Postgres instances, the app) and the
internet — and held a credential that could read or alter every other workspace's test data.

**Decision.**

1. **No gate step has the network.** The PostgreSQL step runs with the network namespace unshared,
   like every other step. Non-database steps receive no database URL at all.
2. **One disposable database per run** (`DisposableGateDatabase`). Outside the sandbox, with the
   admin test URL (`ICOS_TEST_DATABASE_URL`, which must itself name a test database), ICOS creates a
   LOGIN role (no SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS) and a database it owns, both
   `icos_test_gate_<sha256(workspaceId)[:10]>_<nonce>`; `CONNECT` is revoked from PUBLIC. They are
   dropped (`WITH (FORCE)`) in `finally`, success or failure; leftovers of a crashed run of the
   same workspace are swept at the next open.
3. **One door: a gatekeeper socket.** ICOS listens on a UNIX socket in a fresh 0700 directory
   bind-mounted into the sandbox. The gatekeeper reads the PostgreSQL startup packet and forwards to
   the fixed test-cluster address only when it names exactly this run's database AND role;
   replication, cancel requests, unknown protocol versions and other identities are refused (the
   identity check does not rely on `pg_hba.conf`, so it holds on a `trust` cluster). Inside the
   sandbox a small relay listens on the sandbox's own loopback (`127.0.0.1:5432`) and pipes to the
   socket, so any client works with a plain URL; the step receives only
   `ICOS_TEST_DATABASE_URL=postgres://<run role>:<run password>@127.0.0.1:5432/<run db>`. The
   per-run password is redacted from anything the gate keeps.
4. **The gate report is durable.** Every `IntegrationReport` is appended to the audit journal as
   `workspace.gate.reported` (migration 0063 widens `audit_event_type_check`) BEFORE the workspace
   transitions; if recording fails the gate throws and the workspace stays `integrating`.

**Evidence.** `database-gatekeeper.test.ts` (protocol refusals), `integration-gate.test.ts` (no
step has the network; close on failure and on throw; redaction; report recorded before the
transition), `disposable-gate-database.integration.test.ts` (real bwrap + real cluster: the
worker script uses its own database; cannot reach the cluster port, a loopback service, the
internet or DNS; does not see the admin URL or role and cannot log in as admin, to `icos_test`,
to `postgres` or to another live run's database; role privileges and PUBLIC revocation verified
even bypassing the gatekeeper; database and role dropped on success and on failure),
`gate-report-audit.integration.test.ts` (persisted, re-read by a fresh handle, append-only).

**Consequences.**

- Production prerequisite: `ICOS_TEST_DATABASE_URL` must point to a test cluster (database name
  with the `test` token) whose role has `CREATEDB` and `CREATEROLE` (or is superuser of that
  cluster), reachable from the ICOS host over TCP. If it is unset or unreachable the PostgreSQL
  step throws (fail closed) and the workspace stays `integrating`.
- Suites run by the gate may use only their own database: tests that `CREATE DATABASE`, open the
  `postgres` maintenance database, or need Temporal or any other service fail inside the gate.
  `scripts/test-db-setup.ts` now opens the target database first and needs the maintenance
  database only to create a missing one. Deployments choose the suites via `ICOS_GATE_COMMANDS`.
- The role can still read cluster-wide catalogs (`pg_database`, `pg_roles` names) — metadata, no
  data. The upstream hop is plain TCP to the test cluster (SSL requests are answered `N`).
- macOS (Seatbelt) denies UNIX-socket connects with the network: the PostgreSQL step fails closed
  there. The production host is Linux/bubblewrap.

## Amendment A — worker egress is metered (Claude Code via OmniRoute)

**Problem.** A worker sandbox with `allowNetwork: true` reaches OmniRoute on loopback, and
OmniRoute needs no client key there: a worker could spend unmetered, outside every goal cap.

**Decision.** An executor listed in `METERED_EGRESS_EXECUTORS` (`activities.ts`; today
`icos-claude-worker.mjs`) runs with the network **unshared** — no host network, no host loopback.
Per execution, the activity starts `metered-egress-proxy.ts` on a UNIX socket in a directory bound
**read-only** into the sandbox. The proxy serves only `POST /v1/messages` and `GET /v1/models`,
drops worker headers outside a short allowlist (the worker's dummy credential never travels; the
gateway key, if any, is added host-side), and forwards through the **existing** `meteredFetch`
(`composeSpendMeters().mission`, same ledger, same reservations, same goal cap as ICOS's own calls)
under the grant's `{goalId, missionId}`. A DENY never reaches the gateway; the worker gets HTTP 402
`x-should-retry: false`, and the run fails `WORKER_BUDGET_DENIED`. `meteredFetch` now measures
`/v1/messages` and reads Anthropic usage (JSON and SSE `message_start`/`message_delta`, cache
tokens counted as input). The trusted adapter `bin/icos-claude-worker.mjs` bridges
127.0.0.1:<ephemeral> → socket inside the sandbox, runs `claude -p` with a closed tool set, the
routed `{{model}}` (now carried on the grant from the routed worker's registration), a per-run
`--max-budget-usd`, `--setting-sources user` (worktree settings cannot add hooks or permissions),
and never runs git.

**Consequences.** Streaming to the worker is buffered (the meter reads the full SSE before the
proxy answers): correct, not progressive. The token cap is the binding control (no price table);
`--max-budget-usd` is advisory for non-Anthropic model names. The selection is keyed by basename
because it only removes authority. hermes/codex keep `allowNetwork: true`.

**Deployment** (Temporal worker env; no secret here — `OMNIROUTE_API_KEY` stays optional and is
only ever read host-side). `<ICOS>` is the install checkout; the adapter is bound read-only from it.

```sh
ICOS_WORKER_EXECUTABLE_ALLOWLIST='["<ICOS>/bin/icos-claude-worker.mjs"]'
ICOS_WORKER_EXEC_COMMANDS='{"binary":{"command":"<ICOS>/bin/icos-claude-worker.mjs","args":["--prompt","{{prompt}}","--model","{{model}}","--max-budget-usd","0.50","--timeout-ms","840000","--allow-bash","pnpm test*","--allow-bash","pnpm vitest run *"],"timeoutMs":900000}}'
OMNIROUTE_BASE_URL=http://127.0.0.1:20129   # the proxy's upstream; never visible in the sandbox
DATABASE_URL=…                              # the spend ledger + reservations (required: no DB, no run)
ICOS_GOAL_MAX_TOTAL_TOKENS=500000           # the binding cap (default 500000)
ICOS_MAX_OUTPUT_TOKENS=8192                 # per-call output ceiling written into each request
TMPDIR=/tmp                                 # socket path must stay < 100 bytes
```

Compute workers (`compute-fleet.ts`, runtime `binary`, one per OmniRoute model) carry
`metadata.model`; the grant now returns it, so `{{model}}` is the routed model, and a command
naming `{{model}}` with no routed model is refused (`WORKER_EXEC_UNROUTABLE`).
