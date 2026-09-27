# M5 POST-PHASE AUDIT — Multi-worker orchestration

Date: 2026-09-27
Commits: a090bf0 (M5.2), 7daf6c2 (M5.3 + M5.5), 56a79ea (M5.4)
Preceding: 90649f3 (M5.1), 79c6c2e (M4)
Decisions: 0033, 0034, 0035

## 1. WHAT M5 WAS ASKED TO CLOSE

Two defects carried from M5.1:

- **Defect 14** — probe evidence could be RECORDED but nothing PRODUCED it, and
  the recorded verdict had no timestamp.
- **Defect 15** — selection was first-eligible-by-id: ten ready tasks and three
  healthy capable workers all went to one worker.

Plus **defect 12** (`dispatch_attempts` had no `worker_id`), which turned out to
be a prerequisite for fixing 15 rather than a separate item: load cannot be
counted per worker if the ledger never records which worker.

All three are closed.

## 2. CERTIFICATION EVIDENCE

| Requirement | Verdict | Evidence |
|---|---|---|
| CAPABILITY_ROUTING_PRESERVED | PASS | `postgres-multiworker-orchestration` — an idle worker lacking the capability is refused while a loaded capable one is chosen. M4's 26 routing proofs still pass unchanged (2 reason lists extended, no semantics relaxed). |
| HEALTH_PROBING_PROVEN | PASS | 13 unit + 11 PostgreSQL proofs. A registered worker is ineligible until probed; probing makes it routable; a DIFFERENT process routes to it from the durable rows alone. |
| STALE_HEALTH_FAIL_CLOSED | PASS | Refused at the READ boundary (`HEALTH_EVIDENCE_STALE`) and durably invalidated in the STORED state (`expireStaleEvidence` → unknown/unknown/stale). Both verified; a cold process refuses aged evidence. |
| DURABLE_WORKER_LOAD_PROVEN | PASS | Load derived by counting non-terminal `dispatch_attempts`; a fresh process derives the identical tally (2 for W1, 1 for W2). No counter column exists. |
| MULTIWORKER_DISTRIBUTION_PROVEN | PASS | 10 ready tasks + 3 single-slot workers → 3 distinct workers occupied, 7 tasks left ready. Before M5.3 all 10 went to one worker. |
| ATOMIC_MULTIWORKER_DISPATCH_PROVEN | PASS | Two concurrent `prepare()` calls naming the same single-slot worker → exactly 1 acquired, 1 `WorkerCapacityExceededError`, and NO durable trace of the loser. |
| SAFE_PARALLELISM_PROVEN | PASS | Two and three concurrent supervisors dispatch each task exactly once, on distinct workers; the full diamond completes with one attempt per node. |
| DEPENDENCY_GATING_PROVEN | PASS | C never offered while one parent is in flight; mutating readiness to accept a `queued` dependency fails 2 proofs. |
| EXACTLY_ONCE_DAG_ADVANCEMENT_PROVEN | PASS | C dispatched exactly once after both parents complete, across 3 extra supervisor runs and 3 concurrent supervisors, and again after replayed completions. |
| PROCESS_RESTART_PROVEN | PASS | Restart with A and B in flight → byte-identical attempt rows, no re-dispatch; distribution continues rather than restarting a rotation; orphaned `prepared` attempt replayed under the SAME workflow id. |
| CORE1_REGRESSION_PASS | PASS | `src/test/n1-restart-recovery.test.ts` 1/1. |
| CORE2_REGRESSION_PASS | PASS | 15 files / 64 tests: dispatch-race, concurrent-dispatch-recovery, multiworker-concurrent, dag-multibranch, mission-restart, dispatch-recovery, autonomous-mission-runner-restart, dispatch-attempt-repository, mission atomicity/apply-plan/runtime. 0 failures. |
| TYPECHECK_PASS | PASS | `tsc --noEmit` clean. |
| BUILD_PASS | PASS | `next build` completed, full route manifest emitted. |
| DIFF_CHECK_PASS | PASS | `git diff --check` clean on every commit. |

Additional gates: lint 0 errors / 289 warnings (EQUAL to the M3/M4 baseline — the
one warning M5 briefly introduced was removed); migrations 0043 and 0044 each
applied 3× via psql, exit 0 each time; `db:verify-ledger` → LEDGER_OK 42 rows.

## 3. TEST BASELINE

| | M4 (STATE.md) | Session start (measured) | M5 (measured) |
|---|---|---|---|
| unit | 1619 | 1651 after M5.2 | **1667 pass** |
| integration | 321 / 3 / 0 | **327 / 3 / 0** | **369 / 3 / 0** |

The session-start integration figure (327) was measured, not inherited: the
handoff note said 301 and STATE.md said 321. Neither was current. +42 proofs
added by M5 (11 health, 16 distribution/capacity, 15 orchestration).

The 3 failures are `auth-bootstrap-cli` (D1), unchanged, NOT skipped.

## 4. MUTATION TESTING

16 mutations were applied and reverted. Every one that should fail, failed:

| Mutation | Result |
|---|---|
| freshness gate removed from the matcher | 5 unit proofs fail |
| failed probe collapsed to `never` | 1 fails |
| unprobeable worker kind fails OPEN | 1 fails |
| stale-evidence expiry disabled | 3 fail |
| distribution ordering removed (unit) | 2 fail |
| `AT_CAPACITY` gate removed (unit) | 4 fail |
| pool gate removed (unit) | 2 fail |
| pool ceiling resolved UPWARDS (`Math.max`) | 1 fails |
| atomic capacity guard removed from `prepare` | 3 integration proofs fail |
| `worker_id` not recorded | 12 fail |
| distribution ordering removed (integration) | 1 fails |
| a `queued` dependency counts as complete | 2 fail |
| stale-attempt guard removed | 1 fails |
| `worker_id` not recorded (M5.4 suite) | 4 fail |
| **pool gate removed alone (integration)** | **0 fail — see below** |
| **ordering removed alone (M5.4 suite)** | **0 fail — see below** |

The last two are the most informative results in this phase. Two properties are
enforced REDUNDANTLY, so removing one layer leaves the behaviour intact:

- **Pool limits** — enforced by the matcher gate AND by the `prepare()`
  transaction guard. Removing BOTH fails the 2 pool proofs.
- **Worker separation** — enforced by the least-loaded ordering AND by
  `AT_CAPACITY`. Removing BOTH fails 6 proofs.

This is defense in depth, and it is deliberate: the read boundary spreads work in
the normal case, the write boundary is what holds when the load snapshot is stale
— which it always can be, since it is read outside the transaction. It is
recorded here so a future reader does not mistake the redundancy for dead code
and delete one half.

## 5. WHAT M5 DID NOT DO

- **No second matcher.** Every gate added (`HEALTH_EVIDENCE_MISSING`,
  `HEALTH_EVIDENCE_STALE`, `AT_CAPACITY`, `CAPACITY_POOL_SATURATED`) lives in the
  ONE canonical authority, `src/core/workers/worker-eligibility.ts`. It remains
  pure: clocks and load arrive as data, which is what preserves
  `ROUTING_SURVIVES_RESTART`.
- **No fail-closed semantics weakened.** Every new gate is an additional refusal.
  The only permissive path is still `ROUTING_UNCONFIGURED` on a genuinely EMPTY
  registry, unchanged from M4.
- **No in-memory load state.** There is no `workers.current_load` column and no
  round-robin cursor. Load is counted from the ledger on every decision.
- **No Resource Manager.** `capacity_pool` is the minimum vocabulary that keeps
  Worker / Model / Provider / Account / CapacitySlot separable; the manager itself
  is still deliberately unbuilt.

## 6. HONEST GAPS

1. **Nothing real is probed yet.** No `WorkerHealthProbePort` adapter exists, so
   in the wired container every worker kind reads `unsupported` and routes
   nothing. That is the correct fail-closed state, and it is M6's job to change
   it. Until then the probe LOOP is proven but the fleet is empty.
2. **No worker-death recovery.** A worker that dies mid-execution is DETECTED
   (its evidence expires, it becomes ineligible) but the task it was holding is
   not reassigned: the attempt stays `dispatched` and its capacity stays
   consumed. Detection without reassignment is M7's gap, not a defect in M5.
3. **Fairness is unweighted.** Equal-capacity workers are balanced within one
   job. Cost, latency and priority are not inputs. Adding them means adding a
   score, and the score must still derive only from durable rows.
4. **`AIResourceCatalog` is still a second capability source** with zero
   consumers on the dispatch path (defect 10, unchanged).
5. **D1 remains.** 3 `auth-bootstrap-cli` failures, pre-existing, not skipped,
   blocking final ICOS_SELF_BUILD_E2E certification.

## 7. PROCESS NOTE

One failure in this phase looked like a routing defect and was not: `recover()`
replays the latest checkpoint, so an integration suite that truncated missions and
tasks but not `checkpoints` inherited the previous test's DAG state. Diagnosis
required dumping the durable rows rather than reading the assertion. Recorded in
decision 0035 and in STATE.md so it is not re-learned.

Two other "failures" were wrong ASSERTIONS, not wrong code: the canonical
completion path continues the mission itself (so C is already dispatched when the
second parent's completion returns), and `claimPrepared` rejects a non-positive
lease by contract. Both tests were corrected to assert the real behaviour rather
than the behaviour assumed.
