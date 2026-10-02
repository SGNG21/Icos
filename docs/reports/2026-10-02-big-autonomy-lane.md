# Big Autonomy lane — state reconciliation and evidence

Lane: `feat/big-autonomy-ui-self-improve`
Date: 2026-10-02
Role: implementation-only lane. Another session owns integration-central and the live runtime.

## Lane boundaries honoured

This lane did NOT: modify integration-central, touch port 3310, write the live database,
restart the live runtime, register live workers, or deploy. Every change is a certified commit
on this branch or a child worktree branch, for the central owner to integrate.

## 1. Reconciled real state (verified, not assumed)

| Item | Finding | How verified |
|---|---|---|
| integration-central HEAD | `732f662` | `git -C .../integration-central log` |
| This lane's base | identical to central, `0/0` divergence at creation | `git rev-list --left-right --count` |
| Central working tree | clean | `git status --short` |
| Chief Supervisor lane | `feat/icos-chief-supervisor @ 0ab6a83`, based `660b41f`, i.e. exactly 1 commit behind central | `git merge-base`, `git log` |
| Live runtime | one process listening on `127.0.0.1:3310` (`scripts/voice-server.ts`, run from integration-central) | `lsof -nP -iTCP -sTCP:LISTEN`, `ps` |
| Cockpit on :3000 / :3001 | nothing listening | `curl` both ports |
| Live DB | `icos_n23_probe` | test guard names it as the live base |
| Decision numbering | central owns `..0064`; CS lane claims `0065`; this lane claims `0066` | `ls docs/decisions` |
| Migration numbering | central owns `..0054` (journal idx 51); next free is `0055` | `drizzle/meta/_journal.json` |
| Base gates before any change | typecheck clean; **219 test files / 2925 tests passing** | `pnpm typecheck`, `pnpm test` |

### Owner-reported live facts, NOT independently re-verified by this lane

Read-only queries against the live database were blocked by this session's safety policy, so
the following are carried as the owner reported them and are explicitly **not** this lane's
own measurement:

- 15 compute workers registered, 13 healthy/routable, 2 failed on malformed OpenCode route/model keys;
- `workforce_agents` = 0;
- no autonomous mission launched; no live DB write performed;
- probe failure reasons are not durable.

## 2. Worker fleet — what was requested vs what actually ran

The owner requested 4x Hermes/NVIDIA + 1x Hermes/OpenRouter + 1x Codex GPT-5.6 Sol. The owner
also instructed: record UNAVAILABLE truthfully and never pretend a requested model ran.

| Requested | Actual | Evidence |
|---|---|---|
| Hermes CLI present | YES — `/Users/coco/.local/bin/hermes` | `command -v` |
| Hermes default model | `nvidia/nvidia/nemotron-3-ultra-550b-a55b` via a local OpenAI-compatible gateway at `127.0.0.1:20129` | `~/.hermes/config.yaml` |
| Hermes functional | YES — returned `PROBE_OK` | live one-shot probe |
| Codex CLI present | YES — `/Users/coco/.local/bin/codex`, model `gpt-5.6-sol` | `~/.codex/config.toml` |
| Codex highest reasoning effort | **`max`** (not `xhigh`; both accepted, `max` is higher) | both probed live, each returned `PROBE_OK` |
| Hermes via **OpenRouter** | **UNAVAILABLE** | OpenRouter appears only in a commented-out block of `~/.hermes/config.yaml`; `OPENROUTER_API_KEY` is not set; the hermes credential pool lists only copilot / openai-api / anthropic / two custom localhost endpoints |
| Hermes + Codex as autonomous implementation agents | **BLOCKED by this session's safety policy** ("Create Unsafe Agents") — launching them non-interactively requires bypassing all tool approvals | denial returned on the launcher and on further inspection of hermes approval options |

**Consequence, stated plainly:** the four implementation lanes did NOT run on Nemotron. They ran
as sanctioned Claude subagents, which are properly permissioned in this harness. Provider
diversity on implementation was therefore lost. Reviewer diversity was preserved where
possible, which is the axis that actually protects correctness: no implementer is the sole
reviewer of its own work.

## 3. Phase A — Chief Supervisor integration

Reconciled against current central rather than cherry-picked. Collision audit done from
`git diff`, not from filenames, because name-based ownership has been wrong in this repository
before:

- file overlap between the CS lane and central's tip commit `732f662` (lane E, `src/server/workers/*`): **none**;
- decision number `0065`: **free**;
- migrations: the CS lane adds none.

Merged at `ce259d6`. Preserved authorities: Priority Governor, Portfolio Governor,
ObjectiveCoordinator, objective read model, `GoalRepository.list`. No new scheduler, no parallel
mission authority.

## 4. Autonomy blockers — confirmed in code

| ID | Blocker | Confirmed by |
|---|---|---|
| B1 | no enforceable monetary cap: `goals.budget` persisted, never enforced; no price source, no usage accumulator, no enforcement point | `schema.ts` `goals.budget`; `grep -rn 'prompt_tokens' src` matches exactly ONE unrelated file (`src/core/context/contracts.ts`), proving OmniRoute usage is discarded |
| B2 | requested runtime bounds cannot be honoured | the same constants duplicated at `src/server/usecases/start-autonomous-mission.ts:56` and `src/server/autonomy/autonomous-mission-runner.ts:140`. **Nuance:** the per-mission columns and the injectable `options` already exist — the gap is that nothing carries a request into them and nothing clamps it |
| B3 | no per-mission model/provider restriction | all registered workers expose identical capabilities; no allowlist type exists |

The single enforcement seam for B1 and B3: all five OmniRoute completion call sites
(`cognition.ts:143`, `omniroute-autonomous-mission-planner.ts:48`, `omniroute-reviewer.ts:120`,
`compute-fleet.ts:145`, `omniroute-ceo-client.ts:75`) take an injectable `fetchImpl: typeof fetch`
defaulting to global fetch. One decorator therefore meters and gates all five.

## 5. Phase C — why `workforce_agents` = 0

**Classification: B — registry not seeded, and deliberately so.** Not a missing integration.

- the table exists (`drizzle/0051_digital_workforce.sql`) and has a working store with
  integration tests (`src/server/workforce/postgres-workforce-store.ts`);
- the store is wired into the container for BOTH backends (`container.ts:485` memory, `:958` postgres);
- `src/core/workforce/bootstrap.ts` states in its own header that templates "seed a registry;
  nothing here creates an agent or grants a tool" — it seeds `organization.json`, `roles.json`
  (24 roles) and `skills.json`, and there is **no agents seed at all**.

So the brains were never created. The fix is seed data, not plumbing. Decision 0066 records the
field-by-field verification that the twelve brains need **zero new schema**.

## 6. Test isolation

A dedicated database `icos_bigauto_test` was created for this lane. Two integration runs sharing
one `ICOS_TEST_DATABASE_URL` truncate each other and manufacture false regressions, so
implementation workers were forbidden from running the integration suite at all; the coordinator
runs it serially. The repository's own guard (`src/server/database/test-database-guard.ts`)
independently makes the live base unreachable from tests: the name must contain a `test` token
and must not contain `probe|live|prod`, and the live base is `icos_n23_probe`.

## 7. Results

### Gates (measured, not claimed)

| Gate | Base (before any change) | After integration |
|---|---|---|
| typecheck | clean | clean |
| lint | 0 errors / 280 warnings | 0 errors, same 280 pre-existing warnings |
| unit suite | 219 files / 2925 tests | 237 files / 3151 tests |
| integration suite (dedicated DB `icos_bigauto_test`) | 71 passed, 15 skipped / 540 passed, 125 skipped, exit 0 | identical: 71 passed, 15 skipped / 540 passed, 125 skipped, exit 0 |

(The "after" row is a measured `pnpm test` run at this commit, not a projection. An earlier
draft of this table carried a predicted count; it was wrong and is corrected here, because a
fabricated number in an evidence document is the same class of defect as an overstated decision.)

No pre-existing test was weakened, skipped or deleted. Three test assertions were **inverted or
updated on purpose**, each because the change made the old assertion state something false:
the cockpit's "escalations are unreadable" claim, its "escalated is an explicit gap" claim, and
the production-services scheduler options shape. Each is recorded in its commit message.

### INSTALLED vs AUTHORED — the distinction that matters

An independent adversarial review (no CRITICAL, 7 HIGH) established that most of this lane is
**authored and tested in isolation but has no production caller**. That is recorded here in the
same words it was found in, because the alternative — letting an accepted decision assert a
safety property the code lacks — is the defect that stops a team from checking.

| Capability | State | Evidence |
|---|---|---|
| Chief Supervisor (Phase A) | **INSTALLED** | merged, reconciled against current central, gates green |
| Namespace traversal fix | **INSTALLED** | single choke point, mutation-verified |
| Client-less live state | **INSTALLED** | `IS NULL` read, first tests for that source |
| Escalated work visible | **INSTALLED** | port + in-memory + loader + pipeline stage |
| Self-development trigger | **INSTALLED, OWNER-GATED, DEFAULT OFF** | own timer; `ICOS_SELF_DEVELOPMENT=enabled` |
| Spend meter (B1) | **AUTHORED, NOT INSTALLED** | no ledger constructed; no `BudgetCapResolver` exists; `goals.budget` still unread |
| Model allowlist (B3) | **AUTHORED, NOT INSTALLED** | no caller outside its own test |
| Runtime bounds (B2) | **AUTHORED, PARTLY INSTALLED** | resolver + clamp wired into `startAutonomousMission`, but no caller passes `input.bounds`, so not closed end to end |
| 12 brains | **AUTHORED AND VALIDATED, NOT SEEDED** | `loadBrains` has no caller; `workforce_agents` still 0 |
| Chief delegation / intake | **AUTHORED, NOT INSTALLED** | pure policy, no route or container wiring |

Consequence, stated plainly: **B1 is not closed, B3 is not closed, B2 is not closed end to end,
and the brains are not seeded.** A correct, tested mechanism exists for each.

### Why no autonomous mission was launched

The owner authorised a first controlled autonomous mission with a EUR 5 ceiling, and instructed
that if a hard cap cannot actually be enforced it must not be claimed. It cannot:

1. the spend meter has no production caller, so nothing accumulates spend at all;
2. the price table ships EMPTY on purpose, because inventing an OmniRoute tariff would be a
   fabrication — so even once installed, every call is UNPRICED and no monetary cap is
   satisfiable. Only a token cap would be enforceable;
3. four HIGH fail-open defects were found in the budget arithmetic before it was ever wired
   (a zero price reading as priced; provider-billed reasoning tokens charged at zero while
   reported as fully priced; a metered observation without a cost counting as free; and the
   decorator metering non-completion requests, which would deny an attribution forever after a
   single model-discovery call).

Launching a paid mission under those conditions would have produced a false claim of enforcement.
It was not launched. No live DB write, no deploy, no external side effect.

### Next actions, in order

1. Fix the four budget fail-opens (in progress on a repair lane) — required before anything under
   `src/core/budget` or `src/server/budget` is wired to production.
2. Install the meter: construct a ledger, implement a `BudgetCapResolver` over `goals.budget`,
   wrap the five `fetchImpl` seams at construction.
3. Obtain real OmniRoute prices from the owner and fill the price table, with provenance. Until
   then only a token cap is enforceable and that is what must gate a first mission.
4. Seed the brains AND wire `WorkforceComputePort.requestFor` to a CORE3 call site — seeding
   alone yields twelve rows the dispatcher ignores.
5. Carry requested bounds from the intake into `startAutonomousMission.input.bounds`, closing B2
   end to end.
6. Only then consider the first controlled autonomous mission, gated on a token cap and a
   bounded model allowlist.

## 8. Independent review, and what it changed

An independent adversarial reviewer was run against the whole branch with an explicit brief to
break the safety claims rather than confirm them. Verdict: **no CRITICAL, 7 HIGH,
INTEGRATE WITH FIXES**. Its most valuable finding was not a bug but an overstatement: four of the
five headline capabilities had no production caller while an accepted decision asserted, in the
present tense, that they were installed and enforcing. That is recorded in §7 and corrected in
decision 0066.

The coordinator independently re-verified every HIGH before acting on it. None was taken on trust.

| Finding | Verified | Disposition |
|---|---|---|
| H1 — meter has no production caller; `goals.budget` still unenforced | yes, by `git grep` | a dedicated lane now installs it; until it lands B1 is open |
| H2 — a `0` price reads as PRICED, so a money cap is satisfied forever | yes | fixed: a rate must be strictly positive, else UNPRICED |
| H3 — provider-billed reasoning tokens charged at zero, reported as fully priced | yes | fixed: a provider total above prompt+completion is UNPRICED |
| H4 — a METERED observation with no cost counts as free and invisible | yes (latent) | fixed by a fail-closed guard in `accumulate` |
| H5 — every request on the seam was metered, so one `/v1/models` call denies an attribution forever | yes | fixed: only `/v1/chat/completions` is metered; a streaming completion still records UNMETERED |
| H6 — self-development would starve the durable job queue for up to an hour | yes | fixed: its own timer, non-overlap guard, shutdown does not wait |
| H7 — the branch did not typecheck as committed | was true when observed | already resolved by the next commit; HEAD typechecks clean |

Each budget fix carries revert/restore mutation evidence that the new test actually fails against
the broken version. One pre-existing assertion was **corrected, not weakened**: a test blessed
H3's behaviour by asserting that tokens beyond prompt+completion are not charged. It encoded the
defect. Replacement positive coverage was added so the ordinary pricing path stays tested.

### A consequence of the H3 fix the owner must know

Because a provider total greater than prompt+completion now yields UNPRICED, and because an
UNPRICED call cannot be proven under a money cap, **any provider that reports reasoning or cache
tokens will make every monetary cap DENY** until a tariff for those tokens exists. This is the
intended fail-closed behaviour, not a regression, but in production it will appear as denials
rather than as silent under-counting. The alternative — charging billed tokens at zero — is what
the review classified as HIGH. Token caps are unaffected.

### Reviewer diversity — stated truthfully

The owner asked for implementation by Hermes/NVIDIA and review by Codex GPT-5.6 Sol at the
highest available reasoning effort, and asked that an unavailable model never be presented as
having run. Both CLIs exist and were probed working (`PROBE_OK`; Codex's highest effort is `max`,
not `xhigh`). Neither could be used: launching them non-interactively requires bypassing all tool
approvals, which this session's safety policy blocked as unsafe-agent creation. It was not worked
around.

Consequence: implementation AND review both ran as Claude subagents. Model-family diversity
between implementer and reviewer was therefore **NOT achieved**. What was preserved is the part
that protects correctness in practice: the reviewer had a fresh context, an adversarial brief, no
stake in the work passing, and no knowledge of the implementers' reasoning — and it did in fact
contradict the coordinator on several points, which is the behaviour diversity is meant to buy.
That is weaker than a different model family and is reported as such.

## 9. FINDING — a quarter of the integration suite never runs, and says "passed"

This was found by accident and is probably the most important thing in this report.

13 of 87 integration test files are gated `describe.skipIf(!dockerAvailable)` and use
Testcontainers. **The Docker daemon is not running on this machine**, so all 13 skip. Vitest
reports the run as `71 passed | 16 skipped` and exits 0. Nothing fails, nothing warns, and
"integration suite green" therefore means considerably less than it appears to.

What is NOT being exercised:

| File | What goes unproven |
|---|---|
| `server/auth/auth-foundation.integration.test.ts` | authentication foundation |
| `server/auth/auth-application.integration.test.ts` | auth application layer |
| `server/auth/auth-bootstrap-cli.integration.test.ts` | auth bootstrap |
| `server/database/append-only.integration.test.ts` | **audit append-only enforcement** |
| `server/workforce/postgres-workforce-store.integration.test.ts` | the workforce store the 12 brains depend on |
| `server/repositories/postgres/repositories.integration.test.ts` | the Postgres repositories |
| `server/uow/postgres-capability-uow.integration.test.ts` | transactional unit of work |
| `server/uow/postgres-action-decision-uow.integration.test.ts` | transactional unit of work |
| `server/tool-gateway/postgres-stores.integration.test.ts` | governed tool-gateway stores |
| `server/container.postgres.integration.test.ts` | the Postgres container composition |
| `server/database/capability-schema.integration.test.ts` | capability schema |
| `server/administration/user-agent-administration.integration.test.ts` | user/agent administration |

Three of those are authentication and one is audit append-only — both security properties. The
workforce-store one matters directly to the brain registry: its durability is asserted by a test
that does not run.

This lane converted exactly one of the 13 (the spend ledger) to the local test database, because
durability was that lane's whole purpose and leaving it unproven would have meant claiming
durability on an unexecuted assertion. Running it immediately found a defect **in the proof
itself**: the `goals` fixture omitted `createdAt` and `updatedAt`, both NOT NULL without defaults,
so all three resolver proofs failed on their own fixture. They now pass, 19/19, against real
PostgreSQL.

The other 12 were deliberately NOT converted. Testcontainers gives each file a pristine empty
database; several of those tests likely assume that, and the shared local test database carries
rows from its siblings. A blind conversion would produce confident false results, which is worse
than a visible skip.

**Recommended, for the owner to choose:** either start the Docker daemon before an integration
run and re-run the full suite, or convert those files deliberately, one at a time, verifying each
actually passes rather than merely stops skipping. Until then, treat "integration green" as
covering 74 of 87 files, and do not read it as covering auth or audit append-only.

## 10. Status at a pinned commit, and the second independent review

An independent reviewer — **Codex CLI, `gpt-5.6-sol`, reasoning effort `max`**, run read-only and
sandboxed, i.e. a different model family from every implementer — reviewed the whole branch and
returned **1 CRITICAL, 7 HIGH: DO NOT INTEGRATE.** That verdict stands. This section is the
authoritative status; the status paragraphs inside decision 0066 are superseded.

### Status at `b739284`

| Capability | State | Honest limit |
|---|---|---|
| Chief Supervisor | INSTALLED | — |
| Namespace traversal (canonical identity) | INSTALLED | reviewer found it sound |
| Client-less live state | INSTALLED | — |
| Escalated work visible | INSTALLED | — |
| Self-development trigger | INSTALLED, owner-gated, default OFF | runs on its own timer |
| Price registry | INSTALLED, EMPTY by design | undated legacy entries still representable |
| Spend metering | INSTALLED on the planner seam only | **first call under a money cap is ALLOWED** |
| Reservation / settlement | AUTHORED + PROVEN IN ISOLATION, **no production caller** | reserve/settle not mutually serialised |
| Runtime caps | INSTALLED via the scheduler payload | unreachable from normal intake; not persisted for replan |
| Reduce-only compute policy | INSTALLED at initial planning | not enforced at replan, task routing or review |
| 12 brains | SEEDER + CORE3 SEAM WIRED, **0 rows** | roles are draft; seeding needs a human principal |
| "Ameliore ICOS" intake | INSTALLED | lexical proximity, so semantically overbroad |

### What the reviewer found that my own reporting had understated

1. **CRITICAL - the first billable call is authorized.** `checkBudget` evaluates only the
   HISTORICAL window, so an empty window passes `decide()`; price and usage are discovered only
   after the provider has answered, and the planner sends no output-token limit. With a money cap
   and an empty registry, call one is allowed and already paid for. The reservation mechanism that
   would fix this has NO production caller. I did report that limit, but then described P0-D as
   "proven", which reads as enforced. It is proven in isolation and **not enforced**.
2. **HIGH - `settle()` is not serialised with `reserve()`** and authenticates the reservation
   AFTER writing to the ledger, trusting caller-supplied attribution and reserved amount. Spend
   can vanish between the two protected reads (1,900 committed under a 1,000 cap), and a
   settlement can be charged to a different goal than the one reserved.
3. **HIGH - lease expiry releases budget while the call may still be running**, with no renewal,
   so a nominal 1,000 ceiling can authorise 2,000. Expiry-as-a-predicate was presented as a
   feature; without renewal it is a hole.
4. **HIGH - an empty allowlist env value became UNRESTRICTED**, and a test blessed it: the exact
   permissive-fallback shape this lane existed to eliminate. **Fixed:** present-but-empty now
   refuses to boot, omitted still means unrestricted, and `.env.example` no longer ships those
   variables empty.
5. **HIGH - caps and compute policy are unreachable from normal intake** and are not persisted
   across replan/wake, so a restriction can be silently lost on restart.
6. **HIGH - multiple live brain assignments**: dispatch takes the lexicographically first, so a
   stricter assignment (extra capability, human approval) can be bypassed.
7. **HIGH - portfolio admission is check-then-enqueue**, so concurrent admissions can exceed a
   class ceiling of one.
8. **MEDIUM - my own decisions contradicted the code.** 0066 still claimed three capabilities had
   no callers, and that budget and the allowlist share one enforcement point (they do not - two
   seams). 0068 said brains were "load-bearing immediately" while admitting production creates no
   assignments. Both corrected in place with a status notice rather than a silent edit.

### Consequence

**This branch is NOT integration-ready.** It is a certified set of lane commits with a written-down
defect list - materially better than where the lane started, but the budget enforcement story must
not be described as closed. A token cap plus a bounded model allowlist becomes genuinely
enforceable only once the reservation port has a production caller on every billable seam.

