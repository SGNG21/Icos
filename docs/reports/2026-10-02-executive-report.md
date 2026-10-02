# ICOS — Big Autonomy lane, executive report

Prepared for the owner's return. Lane: `feat/big-autonomy-ui-self-improve`. Implementation-only:
another session owned integration-central and the live runtime throughout.

```
START_HEAD = 732f662   integration/icos-central at lane creation (cut at 0/0 divergence)
END_HEAD   = 74a29c0   58 commits ahead, 106 files, +15415/-89
```

## The one-paragraph answer

ICOS is **closer but not there**. The honest headline is that most of what was missing turned out
to already exist and simply not be *connected* — the self-improvement loop, the objective read
model, the worktree factory and the settlement fix were all present and unreachable. Those are now
reachable. What is genuinely new is a spend meter, runtime bounds, a model allowlist, a 12-brain
seed and a delegation policy — and of those, only the spend meter is installed on a real path.
**No autonomous mission was launched, and that was the correct call.**

## Status

| Item | Status |
|---|---|
| CHIEF_SUPERVISOR_INTEGRATED | **YES** — reconciled onto current central, zero overlap, decision 0065 free |
| UI_GOAL_INTAKE | **ALREADY WORKED** — not built here; submit + approve already reached a dispatched mission |
| OBJECTIVE_READ_MODEL | **NOW REACHES THE UI** — it existed with zero front-end consumers |
| BUDGET_ENFORCEMENT | **PARTIAL** — enforced on mission *planning* only; see the ceiling below |
| WORKFORCE_DELEGATION | **AUTHORED, NOT INSTALLED** — pure policy, no route, no container wiring |
| WORKTREE_AUTOMATION | **ALREADY EXISTED** — the most finished part of the base; not rebuilt |
| SELF_IMPROVEMENT_LOOP | **EXISTED AND COULD NOT START** — now has a production caller, owner-gated OFF |
| COMPUTE_WORKERS | 15 registered / 13 routable — **owner-reported, NOT re-verified** (live reads blocked) |
| DIGITAL_WORKFORCE_AGENTS | **0, unchanged** — "registry not seeded, by design", not a defect |

## Gates (all measured on a verifiably frozen tree, not projected)

| Gate | Base | Final |
|---|---|---|
| typecheck | clean | **clean** |
| lint | 0 errors / 280 warnings | **0 errors**, same 280 pre-existing |
| unit | 219 files / 2925 tests | **241 files / 3220 tests** |
| integration (dedicated DB `icos_bigauto_test`) | 71 passed / 15 skipped, 540 tests | **72 passed / 15 skipped, 559 tests, exit 0** |
| build | not run | **NOT RUN — deliberately**: a live production host runs on this machine and building breaks it |

The integration delta (+1 file, +19 tests) is the spend-ledger durability suite, which previously
skipped silently. No regression anywhere.

## Workers — requested vs actual, stated plainly

The owner asked for 4x Hermes/NVIDIA + 1x Hermes/OpenRouter + 1x Codex GPT-5.6 Sol at highest
effort, and asked that an unavailable model never be presented as having run.

| Requested | Actual |
|---|---|
| HERMES_NVIDIA_WORKERS_USED | **0** — CLI works, Nemotron-3-Ultra reachable, probed `PROBE_OK`; launching it as an autonomous worker was BLOCKED by this session's safety policy as unsafe-agent creation |
| OPENROUTER_WORKERS_USED | **0** — UNAVAILABLE: commented-out config, no API key |
| CODEX_SOL_WORKERS_USED | **0** — CLI works, `gpt-5.6-sol`, highest effort is **`max`** (not `xhigh`), probed `PROBE_OK`; same policy block |
| CLAUDE_SUBAGENTS_USED | **9** — 6 implementation, 1 read-only architecture audit, 1 adversarial reviewer, 1 repair |

The block was not worked around. Consequence: implementation and review ran on the same model
family, so **reviewer family diversity was NOT achieved**. What was preserved is the part that
protects correctness: the reviewer had a fresh context, an adversarial brief, no stake in the work
passing, and it did contradict the coordinator on several points.

MULTI_WORKER_PROVEN = **YES for engineering workers** (9 parallel, isolated worktrees, disjoint
file ownership, zero merge conflicts across 8 lanes). **NOT proven inside ICOS itself.**
INDEPENDENT_REVIEW_PROVEN = **YES as a process**; not as an ICOS runtime capability.
DURABLE_WRITEBACK_PROVEN = **YES for spend** (19/19 against real PostgreSQL, including durability
across a fresh connection). **NOT for mission learning.**

## Three premises in the brief were wrong, and it matters

1. **"settlement CORE3 defect36 exists in another lane"** — false for this base.
   `feat/core3-defect36-dag-settlement` is an **ancestor of HEAD, 0 commits ahead**. Settlement is
   here and wired. The cockpit text claiming otherwise was a stale lie and is corrected.
   **Do not cherry-pick it.**
2. **"workforce_agents = 0 is a defect"** — it is not. `bootstrap.ts` states in its own header
   that it seeds roles and skills and that "nothing here creates an agent". There is no agents
   seed at all. The fix is seed data, and it needs **zero new schema**: every field the 12 brains
   require already has a home in `agentPolicySchema`.
3. **"runtime limits are hardcoded"** — narrower than reported. The per-mission columns and the
   injectable options already existed; only the carry-through and the clamp were missing.

## WHY NO AUTONOMOUS MISSION WAS LAUNCHED

The €5 ceiling cannot be enforced, and the owner's own instruction was not to claim a cap that
isn't real. Four independent reasons, in order of severity:

1. **The price table is empty on purpose.** Inventing an OmniRoute tariff would be fabrication, so
   every call is UNPRICED and **no monetary cap is satisfiable**. Only a token cap is.
2. **Four HIGH fail-opens existed in the budget arithmetic** before it was ever wired — a `0`
   price reading as *priced*; provider-billed reasoning tokens charged at zero while reported as
   fully priced; a metered observation with no cost counting as free; and the decorator metering
   non-completion requests, which would have denied an attribution forever after one model
   discovery call. All four are fixed, each with revert/restore mutation evidence.
3. **Enforcement reaches only mission planning.** Review, worker-execution completions, cognition
   and the CEO client run outside any attribution scope.
4. **The structural ceiling, which is the important one.** Worker task execution does **not** go
   through OmniRoute HTTP — it runs as external CLI subprocesses via `ICOS_WORKER_EXEC_COMMANDS`,
   billed to those providers' own accounts. **An OmniRoute-seam budget therefore cannot see, and
   can never bound, the dominant cost of ICOS.** Bounding it needs a different mechanism
   (per-command token/time limits, or routing workers through the gateway). That is an owner
   decision, not one to take unattended.

AUTONOMY_READY_FROM_UI = **NO**
IMPROVE_ICOS_READY = **NO** — the loop can now be *triggered*; it is not yet safe to let run.

## REMAINING_BLOCKERS

1. No real OmniRoute prices -> no monetary cap, ever, until supplied.
2. `ICOS_GOAL_MAX_TOTAL_TOKENS` unset -> mission completions are DENIED (`NO_ENFORCEABLE_CAP`).
   **This is a deployment precondition**: integrating this lane without setting it, or without
   prices, stops autonomous missions from spending anything. Fail-closed and deliberate, but the
   central owner must know before integrating.
3. Worker execution spend is structurally unmeterable at this seam (see above).
4. The reviewer seam cannot be metered until something opens an attribution scope on the review
   path (`review-execution` / `executions/completed`).
5. The 12 brains are authored and validated but **not seeded**, and seeding alone is not enough:
   `WorkforceComputePort.requestFor` has no CORE3 call site, so they would be 12 rows the
   dispatcher ignores.
6. **12 of 87 integration files never run** (Docker daemon absent) and the suite still reports
   success — including three auth files and audit append-only enforcement.
7. `goals` has no `tenant_id`, so a goal budget is resolved by goal id alone.
8. Decision/migration numbering (`0066`, `0055`) must be re-checked at integration: parallel lanes
   here have collided silently before.

## TOP_5_NEXT_ACTIONS

1. **Supply real OmniRoute prices** (or confirm the unit of `goals.budget` — undeterminable from
   the code, currently pinned at `GOAL_BUDGET_UNITS_PER_EUR = 1`). Until then set
   `ICOS_GOAL_MAX_TOTAL_TOKENS` so a token cap is enforceable and missions can run at all.
2. **Decide how worker-execution spend gets bounded.** This is the real budget problem and the
   only blocker that is architectural rather than mechanical.
3. **Start Docker and re-run the integration suite**, then fix whatever those 12 files reveal —
   auth and audit append-only are currently unproven.
4. **Open an attribution scope on the review path**, closing the second-largest metering gap.
5. **Seed the brains AND wire `requestFor` to a CORE3 call site**, in that order, as one change.

## Evidence

- `docs/decisions/0066-seven-planes-and-twelve-canonical-brains.md` — architecture, with its own
  corrections recorded in place rather than edited away.
- `docs/reports/2026-10-02-big-autonomy-lane.md` — full state reconciliation, the
  installed-vs-authored table, the independent review, and the integration-coverage finding.
- Lane branches `feat/ba-w1-spend-meter` … `feat/ba-w9-budget-wiring`, each certified separately.

## Lane safety

LIVE_DEPLOYMENT = **NO**. LIVE_DB_DESTRUCTIVE_WRITES = **NO** (no live write at all; live reads
were blocked by policy, so the owner's preflight numbers are carried as reported, not re-verified).
EXTERNAL_SIDE_EFFECTS = **NO**. integration-central untouched. Port 3310 untouched. No worker
registered live. Nothing pushed.
