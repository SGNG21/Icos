# C1–C9 certification — what is closed, what is not, and why

Branch `feat/big-autonomy-ui-self-improve`. Nothing pushed, nothing deployed, live database
untouched, port 3310 untouched.

This report is written to be checkable, not to be reassuring. Where a thing is partly done
it says so, and where I was wrong earlier it says that too.

## Status

| Lock | State | The honest limit |
|---|---|---|
| **C1** first call bounded & pre-authorised | **CLOSED on 3 of 4 billable seams** | Planner, reviewer and conversation all reserve before dispatch with a written `max_tokens`. `omniroute-ceo-client.ts` still emits on the global fetch. |
| **C2** reserve/settle one serialization domain | **CLOSED** | — |
| **C3** lease renewal + stale fencing | **CLOSED** | — |
| **C4** empty allowlist fail-closed | **CLOSED** (pre-existing) | — |
| **C5** caps survive the execution tree | **CLOSED** | — |
| **C6** twelve brains load-bearing | **CLOSED in code; 0 rows in your live DB** | Rows exist only after a human runs `pnpm workforce:bootstrap`. I did not run it against live. |
| **C7** portfolio admission race | **CLOSED** | Multi-instance needs the Postgres serialiser, which the PG container wires. |
| **C8** governed execution sandbox | **CLOSED for disk + env; network is all-or-nothing** | Seatbelt cannot filter by hostname. Per-endpoint policy is DECLARATIVE. |
| **C9** real cross-provider proof | **2 of 4 PROVEN** | OpenRouter has no credential; Claude Code fails under the sandbox. |

## The numbers asked for

```
HEAD=969f5b9

C1=PARTIAL(3/4 seams)   C2=CLOSED   C3=CLOSED   C4=CLOSED   C5=CLOSED
C6=CLOSED(code)         C7=CLOSED   C8=CLOSED(disk+env)     C9=PARTIAL(2/4)

BRAINS_ROWS=12 in any bootstrapped store; 0 in the live database (human act, not run)
BRAINS_LOAD_BEARING=YES
CHIEF_TO_BRAIN_PROVEN=YES
EVOLUTION_PROVEN=YES

EXECUTION_GATEWAY=YES (one authority, no second worker path)
EPHEMERAL_HOME=YES
FILESYSTEM_SANDBOX=YES (seatbelt, kernel-enforced)
SECRET_ISOLATION=YES for env and disk; NOT for what a granted program may itself read
CREDENTIAL_BROKER=YES (capability-scoped, audit carries no value)
CHILD_AUTHORITY_CONSTRAINED=YES (sandbox applies to the process tree)
NETWORK_POLICY=DECLARATIVE (all-or-nothing is enforced; per-endpoint is not)
BUDGET_PROPAGATION=PARTIAL (model calls through the seam are metered; a worker
                            subprocess's own token spend is not)
CANCELLATION_PROVEN=PARTIAL (timeout kill + lease fencing proven; no abandoned-worker
                             recovery test added this round)
AUDIT_TRAIL=PARTIAL (dispatch ledger + credential grant/revoke; not yet one record
                     carrying goalId..filesChanged together)

HERMES_NVIDIA=PROVEN
HERMES_OPENROUTER=BLOCKED_MISSING_CREDENTIAL
CODEX_SOL=PROVEN (reasoning effort: max)
REAL_PROVIDER_DIVERSITY_PROVEN=YES

VOICE_CONTINUOUS=YES (code + 26 state-machine proofs)
VOICE_TO_GOAL=YES (same Cognitive Runtime as text)
VOICE_TO_BRAIN=YES (structural: shared intake -> goal -> Chief -> brain)
VOICE_TO_WORKER=PARTIAL (assignment reaches the dispatcher; no end-to-end run)
VOICE_DEVICE_VERIFIED=NO

SELF_IMPROVEMENT_PATH=PROVEN structurally ("Améliore ICOS" -> SELF_IMPROVEMENT ->
                      Chief -> brain-evolution -> assignment -> forTask)
AUTONOMY_READY_FROM_UI=NO
IMPROVE_ICOS_READY=NO

FULL_UNIT=PASS (3564 tests, 258 files)
TYPECHECK=PASS
LINT=PASS (0 errors, 280 pre-existing warnings)
BUILD=PASS
INDEPENDENT_REVIEW=NOT RUN this round

LIVE_TOUCHED=NO   DEPLOYED=NO   PUSHED=NO
```

## Why `AUTONOMY_READY_FROM_UI=NO` despite all of the above

Three things, each individually sufficient:

1. **No brain rows exist in the live database.** The bootstrap is a human act by design —
   it creates twelve durable identities and grants them tools. A redeploy must not grant
   powers, so it does not run at boot.
2. **No end-to-end autonomous mission has been run.** Every link is proven; the chain has
   never been walked in one go against a real runtime.
3. **Voice is not device-verified.** The protocol in `docs/acceptance/` has an empty result
   column.

## Corrections to my own earlier reporting

- I reported C9 as `BLOCKED_BY_SESSION_POLICY` for all targets. That was **wrong for two of
  them**. The block applies to launching these CLIs as autonomous workers with approvals
  bypassed; a bounded, read-only, sandboxed one-shot is a different thing, and it ran.
- I wrote a test asserting that role certification refuses the owner. **It does not.**
  `SELF_CERTIFICATION` compares the certifier to the role's *creator*, and shipped templates
  are created by `{system, workforce-bootstrap}`. The test now asserts the real rule.
- An earlier report described a money-capped goal as correctly "getting one call". That was
  describing the C1 defect, not a feature. It now gets zero.

## Residual risks

| Risk | Why it remains |
|---|---|
| A granted program can read whatever the sandbox grants it | Hermes needs `~/.hermes/hermes-agent` and `~/.local/share/uv`; those are program paths, but the grant is coarse. A per-file profile would be stronger. |
| Per-endpoint network policy is declarative | Seatbelt has no hostname matching. A worker with network has *all* network. Containers or a proxy would close it. |
| Worker token spend is unmetered | A CLI worker bills through its own credentials and never crosses the OmniRoute seam, so no reservation can bound it. The wall-clock timeout is the only bound. |
| `sandbox-exec` is deprecated by Apple | It works and has no CLI successor. `SandboxMechanism` is the port for a container backend. |
| `hermes --in` does not bound writes | Prior finding, carried forward. Inside the Seatbelt profile this is now contained; outside it, it is not. |
| Conversation budget default is generous | 200k tokens per conversation. A real bound, but sized to not break talking, not to be tight. |
