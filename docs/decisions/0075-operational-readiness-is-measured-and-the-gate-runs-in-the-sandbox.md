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
- The gate's PostgreSQL step has full network (no backend filters by host). It holds no secret and
  sees only its worktree and its dedicated test database URL.
- Test suites that the gate runs may not depend on Git (the gitdir is not mounted, by ADR 0073);
  one test was rewritten to read the tree from disk.
- `PARTIAL` is a new tone in the cockpit (`warn`), distinct from `DEGRADED`.
