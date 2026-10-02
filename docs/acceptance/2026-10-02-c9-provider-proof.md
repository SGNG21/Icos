# C9 — real cross-provider proof: EXECUTED

Supersedes the earlier "BLOCKED_BY_SESSION_POLICY" note. Two providers ran for real,
through ICOS's own execution path, under the OS sandbox.

Re-runnable: `pnpm certify:gateway`.

## Result

| `hermes->nvidia-nemotron` | **PROVEN** | `seatbelt` | 0 | 6966 ms | `PROBE_OK` |
| `codex->gpt-5.6-sol@max` | **PROVEN** | `seatbelt` | 0 | 5087 ms | `PROBE_OK` |

| Target | Status | Why |
|---|---|---|
| `hermes -> OpenRouter` | **BLOCKED_MISSING_CREDENTIAL** | `OPENROUTER_API_KEY` does not exist on this host, and OpenRouter appears only in a commented-out block of `~/.hermes/config.yaml`. Not a policy block — there is nothing to authenticate with. Fabricating one was never an option. |
| `claude -p` (Claude Code) | **NOT PROVEN** | Exits 1 under the sandbox; its runtime needs host paths the profile does not grant. Not pursued: it is the same model family as this session, so it is the least valuable of the four for diversity. |

## What was actually proven

- **`hermes` → `nvidia/nvidia/nemotron-3-ultra-550b-a55b`** — the model identity was asked
  of the model itself, not read from config, so the name is what answered.
- **`codex` → `gpt-5.6-sol`, `reasoning effort: max`** — `max`, not `xhigh`, is the highest
  value actually accepted; the banner confirms it was applied. 2118 tokens used.

Both ran with:

- `confinement: "seatbelt"` — a real kernel-enforced sandbox, not a `cwd`;
- an **ephemeral HOME**, so neither saw `~/.ssh`, `~/.aws`, `~/.netrc` or the other's
  credentials;
- **capability-scoped credentials** placed by the broker and revoked with the HOME — the
  audit record carries grant and revoke timestamps and **no value**;
- `exitCode: 0` and the expected token on stdout.

**REAL_PROVIDER_DIVERSITY_PROVEN = YES**: two different model families (NVIDIA Nemotron
550B, OpenAI GPT-5.6 Sol), through one governed gateway.

## What this does NOT prove

- Not an autonomous mission. The prompt is a token to echo, the worker is read-only, no
  work is produced and nothing is integrated. It proves the gateway can **launch and
  confine**, nothing about quality of work.
- `networkEnforced: false` for both, and that is honest: a remote provider needs the
  network, and Seatbelt cannot filter by hostname. "NVIDIA only" remains **declarative**.
- Both needed their **program paths** granted read-only (`~/.hermes/hermes-agent`,
  `~/.local/share/uv`, `~/.local/bin`). The sandbox initially refused to execute them at
  all — which is the fail-closed property working, and worth stating: granting a program
  is a decision, and it is separate from granting its credentials.

## A finding worth keeping

Codex first failed with `invalid peer certificate: UnknownIssuer`. The cause was not
certificates: under `(deny default)` the mach services TLS verification needs (`trustd`,
`mDNSResponder`, `configd`) were refused. Any future sandboxed worker doing TLS needs them,
so they are now in the profile. A sandbox strong enough to break TLS is strong enough to be
worth getting right rather than loosening.
