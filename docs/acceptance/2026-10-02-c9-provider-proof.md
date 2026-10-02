# C9 — real provider proof: what is proven, and what is BLOCKED

**Verdict, stated first so nothing below can be read as a pass:**

```
HERMES_NVIDIA_PROVEN     = NO   (BLOCKED_BY_SESSION_POLICY)
HERMES_OPENROUTER_PROVEN = NO   (UNAVAILABLE — no credential exists)
CODEX_SOL_PROVEN         = NO   (BLOCKED_BY_SESSION_POLICY)
CLAUDE_CODE_PROVEN       = NO   (not executed as a governed worker)
EXECUTION_GATEWAY        = STRUCTURAL (see below)
```

No external agent was launched as an autonomous ICOS worker in this session. The owner's
instruction was explicit: if session policy blocks it, do not bypass it, prove the gateway
structurally, and mark the runtime proof BLOCKED. That is what this file does.

## 1. What is actually installed (verified, read-only)

| Executable | Path | Configuration |
|---|---|---|
| `hermes` | `/Users/coco/.local/bin/hermes` | provider `custom`, base_url `http://127.0.0.1:20129/v1` (a local OpenAI-compatible gateway) |
| `codex` | `/Users/coco/.local/bin/codex` | `model = "gpt-5.6-sol"`, `model_reasoning_effort = "medium"` |
| `claude` | `/Users/coco/.local/bin/claude` | this session's own harness |

Two facts that change the answer, and were checked rather than assumed:

- **`OPENROUTER_API_KEY` is not set.** Hermes → OpenRouter is therefore not "blocked by
  policy", it is **unavailable**: there is no credential to use. Reporting it as blocked
  would be flattering and wrong.
- **`ICOS_WORKER_EXEC_COMMANDS` is not configured.** No runtime has a launch adapter, so
  ICOS would answer `PROVIDER_UNAVAILABLE` rather than invent a command. The gateway refuses
  by default; this is the designed behaviour, not an oversight.

## 2. Why the runtime proof is blocked, precisely

Running `hermes` or `codex` as an **autonomous ICOS worker** means launching them
non-interactively with tool approvals pre-granted — that is what "non-interactive worker"
means. This session's safety policy refuses to create agents in that shape. The refusal is
about *how the child is permissioned*, not about the executables, which both answer a
one-shot probe.

I did not work around it. There is no flag in this repository that disables it, and adding
one would be the defect.

## 3. What IS proven about the gateway, structurally

These are properties of the ONE execution path (`worker-executor.ts` over
`run-process.ts`), each with a test, not a claim:

| C8 requirement | State | Where |
|---|---|---|
| Executable allowlist | **YES** — per-runtime deployment config, **no built-in default**; an unconfigured runtime gets no adapter | `exec-command-config.ts` |
| No unrestricted Bash | **YES** — `shell: false`, argv only, placeholders substituted literally | `run-process.ts` |
| cwd / worktree restriction | **YES** — isolated workspace per attempt | `writer-workspace.ts` |
| Branch / task identity | **YES** — task contract + dispatch attempt | dispatch ledger |
| Environment allowlist | **YES (new)** — allowlist, not blocklist | `child-environment.ts`, 10 tests |
| Secret isolation | **PARTIAL** — env secrets no longer cross; **disk credentials still do** (`~/.claude`, `~/.codex`). Needs a sandbox, not an env var. | same |
| Timeout | **YES** — always set; SIGTERM then SIGKILL | `run-process.ts` |
| stdout/stderr capture | **YES** — bounded, truncation recorded, never silent | same |
| Cancellation | **YES** — timeout kill path | same |
| Lease / fencing | **YES** — `stillOwnsLease()` asked AFTER the run, so a run that lost its lease cannot report | `worker-executor.ts` |
| Audit trail | **YES** — durable dispatch attempts | dispatch ledger |
| Token/budget policy | **PARTIAL** — wall-clock timeout is enforced; a worker subprocess's TOKEN spend is not metered, because it bills through its own credentials and never crosses the OmniRoute seam | — |
| No child permission escalation | **NOT PROVEN** — nothing stops a launched agent spawning its own child outside ICOS. The env allowlist narrows what such a child inherits; it does not re-enter Policy. | — |

## 4. The exact invocations, for whoever runs them

Configuration ICOS would need, and the shape of each run. These are **declarations, not
evidence** — filling in the result column is the proof.

```jsonc
// ICOS_WORKER_EXEC_COMMANDS
{
  "hermes":      { "command": "hermes", "args": ["--model", "{{model}}", "--in", "{{workspace}}", "{{prompt}}"] },
  "codex":       { "command": "codex",  "args": ["exec", "--model", "{{model}}", "-C", "{{workspace}}", "{{prompt}}"] },
  "claude-code": { "command": "claude", "args": ["-p", "{{prompt}}"] }
}
```

```bash
# Only what each run needs, nothing else — the allowlist is the point.
ICOS_WORKER_ENV_PASSTHROUGH=NVIDIA_API_KEY        # hermes -> NVIDIA/Nemotron
ICOS_WORKER_ENV_PASSTHROUGH=OPENROUTER_API_KEY    # hermes -> OpenRouter (key does not exist yet)
ICOS_WORKER_ENV_PASSTHROUGH=OPENAI_API_KEY        # codex -> gpt-5.6-sol
```

Evidence each run must capture, or it is not proof: executable, adapter, provider, model,
mission id, task id, worktree path, usage, exit code.

| Run | Executable | Model | Result |
|---|---|---|---|
| Hermes → NVIDIA/Nemotron | `hermes` | `nvidia/nemotron-…` | |
| Hermes → OpenRouter | `hermes` | — | **blocked: no credential** |
| Codex → GPT-5.6 Sol, max effort | `codex` | `gpt-5.6-sol` | |
| Claude Code | `claude` | — | |

**On Codex effort:** a previous report established that the highest accepted value is
`max`, not `xhigh`; the config currently says `medium`. A run claiming maximum effort must
set it explicitly and capture that it was accepted.

## 5. Known hazard, carried forward

A prior finding in this repository: `hermes --in` does **not** bound where Hermes writes —
writes escaped to `$HOME`. Codex's sandbox did hold. So for Hermes the ICOS workspace
restriction is **advisory**, and a Hermes worker must not be treated as filesystem-confined
until that is retested. This is exactly the sandbox gap named in §3.
