# 0040: A retry nobody routed, and the composition that found it

## Status
Accepted

## Context

M7 (0039) closed defect 17: a worker killed mid-execution has its task reclaimed and its
capacity slot returned. It proved the slot comes back and that a new attempt **can** be
prepared. It did not prove that anything automatically does it, and STATE.md said so.

Following the production path from a recorded failure showed the chain was almost whole:

- `recoverUnregistered` already self-heals — any `task_execution_results` row without a
  QC job gets one, so an M7 reclaim is picked up with no new wiring;
- `DeterministicReviewer` RULE 1 already maps `UNKNOWN_EFFECT` (what M7 records) to
  `RETRY`, not `BLOCK`;
- `QualityControlService` already creates attempt N+1 and dispatches it.

One link was broken, and it was invisible until M6.3 existed.

## Decision

### 1. THE GAP: a QC retry was created UNROUTED

`QualityControlRepository.applyAction` INSERTs the retry attempt directly. It copied
`workerKind` and `capability` from the predecessor and left **`worker_id` NULL**.

Harmless while every dispatcher resolved its own worker. Fatal once one resolves the
worker *from the ledger*: the M6.3 external worker executor reads `attempt.workerId`,
finds nothing, and fails the attempt closed with `PROVIDER_UNAVAILABLE`. The retry
consumed one of a **bounded** number of attempts and changed nothing — and the second
retry would do the same, so a recovered task could never complete.

**The QC service now routes the retry through the canonical `CapabilityRouter`**, the
same instance the supervisor uses. QC becomes a second *caller* of one authority, never a
second authority: routing does not move into persistence, which must not acquire an
opinion about which worker should run something.

The previous worker is **not** excluded. A worker that died has already lost its health
evidence (0033) so the router will not offer it; a worker that hit a transient failure is
a perfectly good choice. Eligibility is the router's job, not a list of grudges.

### 2. A retry must not oversubscribe, so the capacity guard was EXTRACTED

`applyAction` bypasses `prepare()` — and therefore bypassed the capacity guard entirely.
A routed retry could hand work to a worker already at its declared limit, or blow through
a shared pool quota, which `prepare()` would have refused.

`assertWorkerCapacity` was a private method on the dispatch-attempt repository. It is now
a shared module both insert paths call inside their own transaction. **Extracted, not
copied**: two capacity checks are two capacity authorities, and the one that drifts is the
one that stops counting a pool.

### 3. No eligible worker is BACK-PRESSURE, not a verdict

If the fleet can take nothing, QC throws `QUALITY_CONTROL_NO_ELIGIBLE_WORKER` and the job
is released for a later sweep. It does **not** create an unroutable attempt.

Spending a bounded retry to record a FLEET problem as a TASK failure is the failure mode
this avoids, and it matches the dispatch rule that a task with no eligible worker stays
recoverable rather than failing. The error is mapped in `stableReviewError`, so triage is
not sent looking at the reviewer for a capacity outage.

### 4. CORE3 CHAOS CERTIFICATION

One test drives the whole chain under a real fault: route → dispatch a REAL external
worker → the worker **hangs and is killed by its own execution timeout** → the attempt is
classified `STREAM_FAILED` and settled (returning the slot) → the probe observes the
worker is unhealthy → recovery reviews the failure, routes the retry to the OTHER worker,
and dispatches it → the retry really writes and commits → review accepts → the task
succeeds. Asserted on durable rows read from new connections: exactly two attempts,
exactly two results, exactly one success, exactly one branch carrying the work.

Recovery is driven by **successive sweep ticks**, because the sweeper is periodic in
production. One tick cannot both create the retry and review its result —
`recoverUnregistered` runs at the start of a pass, so the retry's result does not exist
yet when the pass that creates it begins. Modelling that honestly matters: a single
all-in-one call would certify a system that does not exist.

## Consequences

- A worker dying mid-execution is now survivable end to end, automatically.
- Defect 19 is unchanged and visible in the certification itself: **two** worker branches
  survive the run, one per attempt. Nothing integrates or reaps them.
- The live-provider proof stays opt-in; the chaos certification uses this process's own
  Node runtime, so it is deterministic and free.

## Evidence

- 1760 unit tests (+6), 5 new PostgreSQL proofs (2 chaos + 3 capacity), 6 mutations.
- Mutations that bite the certification: removing retry routing (the pre-M7.1 state)
  breaks BOTH chaos scenarios; making `UNKNOWN_EFFECT` non-retryable breaks both;
  dropping `worker_id` on the insert breaks the chain.
- integration 420 pass / 3 fail — the 3 are pre-existing D1 auth-bootstrap-cli, a count
  that has never moved. typecheck PASS, build PASS, lint 0 errors / 289 warnings
  (= baseline), `git diff --check` PASS, ledger 44 rows (no migration needed).

### Two defects the composition found that no unit test did

**A latent invalid-review bug.** `ReviewerServiceImpl` built `evidenceRefs` from evidence
**timestamps**, which can never satisfy `idSchema` (lowercase, digits, `-`/`_`) because an
ISO timestamp carries `T`, `Z`, `:` and `.`. Every reviewed result carrying evidence would
throw `QUALITY_CONTROL_INVALID_REVIEW`. It had never fired because nothing attached
evidence to a reviewed SUCCESS until the M6.3 executor did. Now mapped by `type`, matching
`DeterministicReviewer`, with non-conforming labels dropped rather than allowed to
invalidate the whole record — losing a reference is cosmetic, losing the review is not.

**A mutation that survived, and the test it demanded.** Removing the capacity guard from
`applyAction` left the chaos certification green, because its retry always finds a free
slot: the router never *chooses* a full worker, so the guard only fires on the race it
exists for — routing is decided outside the transaction and is therefore advisory. A
dedicated PostgreSQL test now drives that race directly. "Wired" is not "proven", and a
green suite under mutation is information, not a pass.
