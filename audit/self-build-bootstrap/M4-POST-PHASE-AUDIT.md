# M4 Post-Phase Audit

Date: 2026-09-27
Entry HEAD: 716c6b89f8f06ee29606f068003c275742bdc4f0
Scope: CORE3 M4 — capability routing (mission N15), decision 0031

## Entry state verified from the repository, not from the handoff

The handoff was checked before being trusted:

| Claim | Verified | Evidence |
|---|---|---|
| M0–M3 committed and certified | YES | `git log` shows 8b93ab2 (M0/M1), 71ee3aa (M2), 5bb5a2b (M3), each with its audit doc |
| STATE.md CURRENT_HEAD = 5bb5a2b | **STALE** | actual HEAD was 716c6b8; STATE.md predates the CERT commit |
| unit 1585 passing | YES (baseline) | re-measured 1585 before M4 changes |
| integration 301 / 3 failing / 0 skipped | YES | re-measured; the 3 are auth-bootstrap-cli |
| CERT-1 blocks M4 | **ALREADY RESOLVED** | 716c6b8 started Docker and unblocked all 77 gated tests; capability-schema (7) + postgres-capability-uow (4) pass |
| typecheck / diff-check PASS, lint 0 errors | YES | re-measured |

STATE.md's `CURRENT_HEAD` was one commit behind and its M4 entry still declared
CERT-1 as a blocker that 716c6b8 had already cleared. Corrected in this phase.

## Trace result (deliverable 1)

| Concern | Path | Authority after M4 |
|---|---|---|
| Worker eligibility | `src/core/workers/worker-eligibility.ts` | **CANONICAL** (new, sole) |
| Worker eligibility | `IndependentReviewerSelector.select()` | delegates; behaviour unchanged |
| Worker eligibility | `BoundedRepairController.getEligibleWorkers()` | delegates; behaviour unchanged (was a verbatim copy) |
| Worker eligibility | `AdaptedAIResourceCatalog.isRunnable()` | delegates; **TIGHTENED** (was fail-open on `unknown`) |
| Worker capabilities (durable) | `workers` table, migration 0042 | **CANONICAL** |
| Worker capabilities (read model) | `InMemoryWorkerRegistry`, hydrated at container build | derived snapshot, never authoritative |
| Task capability requirement | `tasks.required_capabilities` (0041), read via `MissionTask.taskId` | **CANONICAL** |
| Routing decision | `CapabilityRouter` | sole router; owns no matching logic |
| Dispatch | `SupervisorService.run()` → `routeReadyTask()` | routing runs AFTER `computeReadyTasks`, never instead of it |
| Model / Provider candidates | `AIResourceCatalog` | unchanged, and NOT on the dispatch path (see S1) |

## The defect M4 found and fixed

Three matchers, two semantics:

| Implementation | health gate | availability gate |
|---|---|---|
| `IndependentReviewerSelector` | `=== "healthy"` | `=== "available"` |
| `BoundedRepairController` | `=== "healthy"` | `=== "available"` |
| `AdaptedAIResourceCatalog` | `!== "unhealthy"` | `!== "unavailable"` |

The third failed **OPEN** on `"unknown"` — exactly the value every worker
fixture carries and exactly the registry default. `worker-registry.test.ts`
asserted that three fixtures whose own comments say
`health: "unknown", // Fail-closed: we don't probe health` were runnable. The
test encoded the defect.

That test is now inverted to assert fail-closed, with a second test proving the
mapping still works once workers are genuinely probed. This is a deliberate
tightening, recorded in decision 0031 under Consequences → Negative.

## M4 proofs

All routing-critical proofs were mutation-verified: the gate was deliberately
broken and the test had to fail.

| # | Proof | Status | Evidence |
|---|---|---|---|
| 1 | requiredCapabilities read from the durable canonical task | **PROVEN** | postgres: MissionTask declares NO workerKind; routing derives `hermes` purely from `tasks.required_capabilities` |
| 2 | workers expose durable/queryable capabilities | **PROVEN** | postgres: registered by one handle, read back by another; upsert updates in place |
| 3 | unhealthy/inactive/unavailable rejected | **PROVEN** | unit (6 cases) + postgres (6 cases against real rows) |
| 4 | worker missing ANY required capability rejected | **PROVEN** | unit + postgres; exact match, no prefix (`website` ≠ `website.build`) |
| 5 | UNKNOWN eligibility fails closed | **PROVEN** | unit + postgres: a row inserted with only mandatory columns defaults to inactive/unknown/unknown/UNKNOWN and routes nothing |
| 6 | selection deterministic for equivalent candidates | **PROVEN** | unit (4 input orders) + postgres (3 restarts, reverse insertion order) |
| 7 | no permanent Nemotron/Claude/Codex hardwire | **PROVEN** (scoped, see S1) | grep: 0 provider tokens in matcher, router, store, migration; test asserts it; novel worker kind routes with no code change |
| 8 | routing survives process restart | **PROVEN** | postgres: new handle + re-hydrated registry reaches an identical decision AND identical per-candidate verdicts; a durable health change reroutes after restart |
| 9 | capability state works against real Postgres | **PROVEN** | 20 integration tests, real `icos_test`; migration applied 3× exit 0; `\d workers` verified |
| 10 | reviewer independence still correct | **PROVEN** | postgres: independent capable reviewer selected, producer never selected, refuses rather than self-review |

### Mutation evidence

| Mutant | Killed by |
|---|---|
| health gate fails open on `unknown` | 5 unit tests |
| availability gate fails open on `unknown` | 2 unit tests |
| capabilities matched ANY instead of ALL | 2 unit tests |
| selection order not normalized | 2 unit tests |
| status gate removed | 2 unit tests |
| supervisor ignores `NO_ELIGIBLE_WORKER` | 3 integration tests |
| requiredCapabilities not read from canonical task | 1 integration test |
| routed workerKind discarded | 1 integration test |
| empty registry reported as `ROUTED` | 1 unit test (integration blind — correctly, the supervisor behaves identically) |
| `NO_ELIGIBLE_WORKER` degraded to `ROUTING_UNCONFIGURED` (fail open) | 5 unit + 11 integration tests |

No surviving mutant.

## Worker != Model != Provider != Account != Capacity Slot

Established in decision 0031 §Context and enforced by scope:

- **Worker** — execution unit. The `workers` table, the matcher, the router.
- **Model / Provider** — `AIResourceCatalog` candidates. Untouched by routing.
- **Account / Capacity slot** — no representation, deliberately. Adding one now
  would be the Resource Manager, which M4 was told not to overbuild.

`workers.metadata` may carry provider/model hints; they are NON-AUTHORITATIVE
and read by nothing. Nothing in M4 prevents an M5/M6 Resource Manager: the
router consumes a `WorkerRequirement` and a registry port, both of which a
resource manager can supply or extend.

## Findings

### MUST_NOW
**NONE.**

### SHOULD_NEXT

**S1 — NEW: `AIResourceCatalog` is a second, hardcoded source of worker
capability truth, and its engine is dead.**
It hardcodes worker kinds *with their capabilities* (`agent`, `other`,
`hermes`), model ids (`gpt-4`, `claude-3-opus`, `claude-3-sonnet`) and
providers. `AdaptedAIResourceCatalog` *intersects* the durable registry with
this hardcoded list, so a durably-registered worker kind absent from the list
can never become an AI-selection candidate. This is the residue of M4.7.
It is **NOT** on the dispatch path: `AISelectionEngine` is constructed in
`container.ts` and exposed on `Container`, but grep shows **zero consumers**.
Requirement 7 is therefore proven for the routing path and open for the
selection path. Belongs to the M5/M6 Resource Manager.

**S2 — NEW: the registry read model is a boot-time snapshot.**
A worker registered or re-probed mid-process is invisible to routing until the
next container build. Accepted for M4 (it is exactly what makes restart
survival provable and keeps the blast radius to one line of container wiring).
M5 multi-worker orchestration will want live refresh or a per-route read.

**S3 — NEW: `dispatch_attempts` records the routed `worker_kind` but not the
selected worker `id`.** Adequate for M4; M5 needs the id to attribute work and
to feed reviewer independence with a real producer identity. Additive column.

**S4 — NEW: nothing registers workers yet.** The `workers` table exists, is
durable and is authoritative-when-populated, but no code path writes to it
outside tests. Every deployment is therefore in `ROUTING_UNCONFIGURED` and
routing changes nothing until workers are registered. This is intended for M4
(reversibility) and is M5/M6's entry point.

**S5 (carried, M2/M3) — Persisted planning envelope still only partly honored.**
`requiredCapabilities` now routes (this milestone). `attemptBudget` still bounds
nothing, `reviewPolicy` still branches nothing, and the worker prompt is still
`task.description || task.title`. M5 and bounded repair own the remainder.

**S6 (carried) — Dead duplicate repository.**
`src/server/mission/postgres-mission-repository.ts`: zero importers. Removal
still wants its own commit + ADR.

**S7 (carried) — Two canonical-JSON implementations.**
`mission-plan.ts canonicalize()` vs `scheduler-service.ts canonical()`.

**S8 (carried) — `tasks.dependencies` and the `POST /api/tasks` field should
eventually be removed** (decision 0030 demoted them; they are still present).

### MANDATORY DEFECT BEFORE FINAL BOOTSTRAP CERTIFICATION

**D1 — `auth-bootstrap-cli.integration.test.ts`: 3 tests fail by 60s timeout.**
Pre-existing, CERT-4, first surfaced by 716c6b8. Confirmed NOT caused by M4:
`git status` shows M4 touched no file under `src/server/auth/`, no CLI and no
bootstrap path. These are **not skipped** and must not be re-skipped. They block
final ICOS_SELF_BUILD_E2E certification, not M4.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | PASS |
| `pnpm run test` (unit) | PASS — 133 files, **1619** tests (was 1585; +34) |
| `pnpm run test:integration` | **321 passed / 3 failed / 0 skipped** (was 301/3/0; +20) — the 3 are D1 |
| `pnpm run lint` | 0 errors, 289 warnings (**equal** to the M3 baseline) |
| `git diff --check` | PASS |
| `pnpm run format:check` | still FAIL on 243 files — PRE-EXISTING, untouched (see STATE.md) |
| migration 0042 re-runnable | PASS — applied 3× via psql, exit 0 each time |
| migration 0042 legacy-safe | PASS — row inserted with only mandatory columns upgraded to the fail-closed defaults, no loss |
| `\d workers` on real Postgres | PASS — 15 columns, 5 CHECK constraints, 2 indexes, fail-closed defaults verified |

## Reproduce

```
pnpm run test:db:setup
pnpm run typecheck && pnpm run test
pnpm run test:integration
npx vitest run src/core/workers src/server/routing
npx vitest run --config vitest.integration.config.ts src/server/routing
```
