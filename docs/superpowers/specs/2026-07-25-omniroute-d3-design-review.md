# D3 DESIGN READY REPORT

## Base info

| Field    | Value                                                              |
| -------- | ------------------------------------------------------------------ |
| Branch   | `feat/d3-omniroute`                                                |
| Worktree | `/Users/coco/icos/.claude/worktrees/feat+d3-omniroute`             |
| Base SHA | `8cd58c70d5d174f1a071942ec4eb028c73c41a0e`                         |
| Spec     | `docs/superpowers/specs/2026-07-25-omniroute-ai-gateway-design.md` |

## Existing AI abstractions

**None.** No AI or provider abstraction exists in `src/`. Only env vars
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are declared (disabled).

---

## AiGatewayPort

Interface in `server/ai/ports.ts`:

```typescript
interface AiGatewayPort {
  generate(request: AiRoutingRequestWithSignal): Promise<AiGenerationResult>;
}
```

- Pure async port, no state, no side effects
- Takes AbortSignal for cancellation
- Normalized result type (discriminated union `success: true | false`)
- No provider-ICOS domain coupling

---

## OmniRouteAdapter

Implementation in `server/ai/omniroute-adapter.ts`:

- Maps ICOS `AiRoutingRequest` → OmniRoute HTTP POST
- Maps HTTP response → `AiGenerationResult`
- Maps HTTP errors → normalized `AiError`
- Respects timeout + cancellation via `AbortSignal`
- Propagates tenantId, dataClassification as headers
- No credential provider storage
- No prompt/response logging
- No retry duplication (delegates to OmniRoute)

---

## Request contract (`AiRoutingRequest`)

**Fields:** `prompt`, `systemPrompt?`, `intent` (enum 6 values),
`tenantId`, `dataClassification?`, `maxTokens?`, `temperature?`,
`budgetMaxCostUsd?`, `qualityThreshold`, `allowedProviderIds?`,
`disallowedProviderIds?`, `fallbackAllowed`, `timeoutMs`,
`correlationId`, `modality`, `abortSignal?`

All Zod-validated before transmission.

---

## Response contract (`AiGenerationResult`)

Discriminated union on `success`:

**Success:** `content`, `finishReason`, `provider` (id, model, account?),
`usage` (inputTokens, outputTokens, totalTokens, costUsd?),
`latencyMs`, `routeExplanation?`, `fallbackUsed`

**Error:** `error` (code, message, retryable, fallbackPossible,
providerError?), `latencyMs`, `provider?`, `usage?`, `fallbackUsed`

---

## Error model

| Code                   | HTTP          | Retryable | Fallback |
| ---------------------- | ------------- | --------- | -------- |
| PROVIDER_UNAVAILABLE   | 502-504       | yes       | yes      |
| RATE_LIMITED           | 429           | yes       | yes      |
| TIMEOUT                | —             | yes       | yes      |
| INVALID_RESPONSE       | 200 malformed | no        | yes      |
| POLICY_BLOCKED         | 403           | no        | no       |
| UNSUPPORTED_CAPABILITY | 400           | no        | no       |
| CANCELLED              | —             | no        | no       |
| INTERNAL_ERROR         | 500           | no        | no       |

Fail-closed: any unrecognized error → INTERNAL_ERROR.

---

## Routing model

ICOS expresses **intent** (BEST_REASONING, BEST_CODING, FAST, CHEAP,
PRIVATE, FALLBACK). OmniRoute resolves provider/model/account.

ICOS can constrain via `allowedProviderIds`, `disallowedProviderIds`,
and `fallbackAllowed`.

No routing intelligence in ICOS — OmniRoute is the only authority.

---

## Fallback model

- `fallbackAllowed: true` → OmniRoute may fallback internally
- `fallbackAllowed: false` → signal to OmniRoute (no guarantee in V1,
  guarantee planned for R2)
- `fallbackUsed` returned in result
- No fallback chain managed by ICOS

Known limitation documented: OmniRoute-side fallback may still happen even
when `fallbackAllowed: false`. Mitigated by R2.

---

## Compliance propagation

- `tenantId` → header `X-Tenant-Id`
- `dataClassification` (C0-C3) → header `X-Data-Classification`
- No retention policy sent to OmniRoute (applies post-generation at ICOS level)
- No credentials ever leave ICOS

---

## D2 integration boundary

```
D4 Orchestrator → AiGatewayPort → OmniRouteAdapter → OmniRoute
```

D4 does NOT:

- Call OmniRouteAdapter directly
- Know OmniRoute exists
- Handle provider credentials

D3 does NOT:

- Depend on D4 types (Mission, Plan, Run)
- Define `ai_generations` persistence
- Know the caller's authorization state

**Boundary contract**: `AiRoutingRequest` (with `correlationId` linking to
Mission/Run) and `AiGenerationResult` (returned to D4 for storage).

---

## Non-scope (explicit)

Streaming · Embeddings · Images · Audio · ACP · Memory · Agent Skills ·
Fetch/Search providers · `ai_generations` table · Business routing policy ·
Usage ledger · Operational projections · OmniRoute management · Quality
scoring

---

## Security findings

### Found: no security blocker

| #   | Check                       | Verdict                                                                                                                                               |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Policy bypass               | Not found — AiGatewayPort is an I/O port, authorization is D4's concern. Adapter has no auth logic.                                                   |
| 2   | Tenant leakage              | Not found — tenantId propagated correctly as header. No tenant confusion possible.                                                                    |
| 3   | Provider credential leakage | Not found — adapter uses ICOS→OmniRoute service key, never provider credentials.                                                                      |
| 4   | Direct provider coupling    | Not found — all calls go through OmniRoute HTTP API. No direct provider SDK import.                                                                   |
| 5   | Hidden retries              | Not found — adapter has zero retry logic. OmniRoute owns all retries.                                                                                 |
| 6   | Unbounded fallback          | **Known limitation** — `fallbackAllowed: false` is a signal, not a guarantee in V1. Documented, mitigated by R2. No uncontrolled cost or action risk. |
| 7   | Cost explosion              | Mitigated — `maxTimeoutMs=300000` enforced in adapter, `budgetMaxCostUsd` signaled to OmniRoute. Timeout is the hard safety net.                      |
| 8   | Provider domain leakage     | Not found — provider IDs are normalized strings. No provider objects in ICOS domain.                                                                  |
| 9   | Stale routing state         | Not found — no caching in adapter. Every request goes fresh to OmniRoute.                                                                             |
| 10  | Sensitive payload logging   | Not found — explicit redaction policy: no prompt, response, or credential logged.                                                                     |
| 11  | Cancellation bugs           | Not found — AbortSignal propagated to fetch. No lingering goroutine/promise.                                                                          |
| 12  | Retry duplication           | Not found — adapter has no retry, no timeout re-fetch.                                                                                                |
| 13  | Confused deputy             | Not found — adapter has one fixed OmniRoute endpoint, cannot be redirected.                                                                           |
| 14  | Fail-open                   | Not found — all errors caught, any unhandled → INTERNAL_ERROR with `success: false`.                                                                  |

### Mitigations applied in design

- Timeout max absolute (300s) enforced in config schema
- AbortSignal.any() combines request cancel + timeout correctly
- No fetch body logged (not even length)
- providerError returned in result but explicitly NOT logged
- Config avoids credential in stack traces

---

## Blockers

**NONE** — all findings are clean or have documented mitigation.

---

## VERDICT: READY TO IMPLEMENT

The design passes spec self-review and security review with no blockers.
Proceeding to implementation per handoff directive.

## Next steps

1. Implement `core/ai/contract.ts` + tests
2. Implement `config/env.ts` extension + `.env.example` update
3. Implement `server/ai/omniroute-config.ts`
4. Implement `server/ai/ports.ts`
5. Implement `server/ai/omniroute-adapter.ts` + tests
6. Implement `server/ai/fake-ai-gateway.ts`
7. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
8. `git diff --check`
9. Self-review
10. Commit, push, PR
