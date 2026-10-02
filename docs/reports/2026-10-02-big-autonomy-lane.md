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

(filled in as lanes land — see the sections appended below)
