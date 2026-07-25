# D4 — Runtime Execution Design

**Status:** IMPLEMENTATION_IN_PROGRESS  
**Date:** 2026-07-25  
**Dependencies:** D1 (Policy), D2 (Mission Engine), D3 (AI Gateway / OmniRoute)  

---

## 1. Objectives

D4 owns **execution** — the lifecycle of running a plan step once the Mission Engine (D2) has decided what to do and the AI Gateway (D3) has resolved which provider to use.

- Provide a clean, testable runtime execution contract for D2 to call
- Orchestrate the complete lifecycle: authorization recheck → workspace → credential resolution → execution → artifact collection → cleanup
- Support cancellation, timeout, and process-tree cleanup
- Enforce workspace isolation, network default-deny, credential confinement
- Integrate with D3 via `AiGatewayPort` — never directly
- Remain agent-agnostic; the `LocalRuntimeAdapter` is V1 — future adapters plug in via the same `AgentRuntimeAdapter` interface

---

## 2. Non-Objectives (V1)

- Distributed scheduler
- VPS orchestration (Kubernetes, Nomad, etc.)
- Complete Docker platform
- NemoClaw / OpenClaw / Hermes / Codex integration
- MCP gateway
- Browser runtime
- Voice runtime
- Remote agents
- Streaming D3 V2
- Complex quota systems
- Advanced UI

---

## 3. Canonical Ownership

| Layer | Owner | State Machine |
|-------|-------|---------------|
| D2 Mission Engine | Plan lifecycle | Mission status (CREATED → … → COMPLETED) |
| D4 Runtime Execution | Step/Run execution | Execution status (STARTING → … → SUCCEEDED) |
| D3 AI Gateway | AI request | None (single request/response) |

**Invariant:** These state machines are **never merged**. D2 tracks planning and orchestration state; D4 tracks runtime execution state; D3 tracks AI generation state. Each has its own lifecycle, transitions, and error model.

---

## 4. D3 Contract Reconciliation

### Verified against origin/main (8ac39cb)

| Field | Specified | Actual | Status |
|-------|-----------|--------|--------|
| `AiGatewayPort` signature | `generate(request: AiRoutingRequestWithSignal): Promise<AiGenerationResult>` | ✅ Matches | PASS |
| `tenantId` | Required | `z.string().min(1)` | PASS |
| `correlationId` | Required | `z.string().min(1)` | PASS |
| `AbortSignal` | Via `AiRoutingRequestWithSignal.abortSignal` | ✅ Present as optional field | PASS |
| Routing intents | BEST_REASONING, BEST_CODING, FAST, CHEAP, PRIVATE, FALLBACK | ✅ All 6 present | PASS |
| Error codes | PROVIDER_UNAVAILABLE, RATE_LIMITED, TIMEOUT, INVALID_RESPONSE, POLICY_BLOCKED, UNSUPPORTED_CAPABILITY, CANCELLED, INTERNAL_ERROR | ✅ All 8 present | PASS |
| Usage metadata | inputTokens, outputTokens, totalTokens, costUsd? | ✅ All 4 present in `AiUsage` | PASS |
| Provider info | id, model, account? | ✅ All 3 present in `AiProviderInfo` | PASS |
| `fallbackAllowed` | boolean, default true | ✅ Present | PASS |
| `budgetMaxCostUsd` | optional max cost | ✅ Present | PASS |

**Divergences:** None — the D3 contract matches exactly what was designed. No spec update needed.

### D4 consumes D3 via

```typescript
AiGatewayPort.generate({
  ...AiRoutingRequestWithSignal,
  // D4 sets: tenantId, correlationId, prompt (from step), intent, abortSignal, timeoutMs
  // D4 does NOT set: provider-specific config (that's D3's job)
})
```

---

## 5. Runtime State Machine

### States

```
STARTING   → Being prepared (workspace, policy, credentials)
RUNNING    → Adapter is executing
SUCCEEDED  → Completed successfully (terminal)
FAILED     → Execution failure (terminal)
CANCELLED  → User/system cancellation (terminal)
TIMED_OUT  → Exceeded timeout (terminal)
LOST       → Worker/process disappeared (terminal)
```

### Allowed Transitions

```
STARTING  → RUNNING          (normal progression)
STARTING  → FAILED           (setup failure: policy deny, workspace error, credential unavailable)
STARTING  → CANCELLED        (cancelled before execution)

RUNNING   → SUCCEEDED        (normal completion)
RUNNING   → FAILED           (execution failure)
RUNNING   → CANCELLED        (cancellation during execution)
RUNNING   → TIMED_OUT        (timeout exceeded)
RUNNING   → LOST             (worker disappeared)

TERMINAL  → <none>           (no transitions out of terminal states)
```

### Illegal Transitions (denied with explicit error)

- Any transition from a terminal state
- Non-sequential transitions (e.g., STARTING → SUCCEEDED)
- Impossible transitions (e.g., FAILED → RUNNING)

---

## 6. Architecture

```
D2 Mission Engine
        │
        ▼
RuntimeExecutionPort              ← D4 contract boundary
        │
        ▼
ExecutionOrchestrator             ← D4 coordinator
        │
        ├── D1PolicyPort          ← execution-time authorization recheck
        │
        ├── WorkspaceManager      ← isolated workspace lifecycle
        │
        ├── CredentialBrokerPort  ← credential resolution boundary
        │
        ├── NetworkPolicyPort     ← network default-deny boundary
        │
        ├── ArtifactCollector     ← scoped artifact extraction
        │
        ├── AgentRuntimeAdapter   ← adapter interface
        │     └── LocalRuntimeAdapter  ← V1 local process execution
        │
        └── AiGatewayPort         ← D3 AI generation (for AI-backed steps)
```

### Runtime Execution Port (D2 → D4)

```typescript
interface RuntimeExecutionPort {
  execute(input: ExecuteStepInput): Promise<ExecutionResult>;
}
```

### Execution Orchestrator Flow

```
1. receive ExecuteStepInput
2. D1 re-check: D1PolicyPort.decide(executionRequest)
   └─ if DENY     → FAILED (POLICY_DENIED), do not proceed
   └─ if REQUIRE_APPROVAL → FAILED (REQUIRES_APPROVAL), mission must handle
   └─ if ALLOW    → continue
3. state = STARTING
4. workspace = WorkspaceManager.create()
5. credentials = CredentialBrokerPort.resolve()
6. network = NetworkPolicyPort.check()
7. adapter = resolveAdapter()  [currently LocalRuntimeAdapter]
8. state = RUNNING
9. result = adapter.execute({ ...with abortSignal, timeout })
10. artifacts = ArtifactCollector.collect(workspace)
11. cleanup: WorkspaceManager.release(workspace)
12. state = finalState (SUCCEEDED | FAILED | CANCELLED | TIMED_OUT | LOST)
13. return ExecutionResult
```

---

## 7. D1 Execution-Time Recheck

Planning-time authorization is NEVER sufficient. Immediately before execution, D4 **must** re-evaluate through `D1PolicyPort.decide()`.

The policy request for execution includes:

```typescript
{
  actor: { kind: "agent", id: agentId, tenantId },
  tenant: { tenantId },
  action: "runtime.execute",
  resource: {
    type: "execution",
    id: runId,
    ownerTenantId: tenantId,
  },
  risk: input.stepHasExternalEffect ? "sensitive" : "reversible",
  hasExternalEffect: input.stepHasExternalEffect,
}
```

If the policy decision is:
- `ALLOW` → continue
- `DENY` → return `FAILED` with `error.code = "POLICY_DENIED"`
- `REQUIRE_APPROVAL` → return `FAILED` with `error.code = "REQUIRES_APPROVAL"` (D2 handles the approval workflow)

---

## 8. Workspace Isolation

Each execution gets an isolated workspace directory. The `WorkspaceManager` is the single authority for workspace lifecycle.

### Directory Structure

```
<root>/
  workspaces/
    <tenantId>/
      <runId>/
        input/
        output/
        temp/
```

### Security Protections

- **Path traversal (`../`):** All resolved paths are checked against the workspace root. Any attempt to escape returns `WORKSPACE_ESCAPE_DENIED`.
- **Symlink escape:** Before traversal into directories, symlinks are resolved to their real paths. A symlink targeting outside the workspace is treated as escape.
- **Absolute path escape:** Input paths are normalized. Absolute paths are rejected unless they resolve within the workspace.
- **Cross-run isolation:** Each run gets its own directory. No two runs share a workspace.
- **Cross-tenant isolation:** Workspaces are namespaced by `tenantId` directory.
- **Cleanup safety:** `release()` validates the path is within the managed root before deleting. Uses a safe recursive delete that refuses to delete the root itself.

---

## 9. Credential Model

**NON-NEGOTIABLE RULE:**

> AGENT ≠ RAW CREDENTIAL HOLDER

### Architecture

```
ExecutionOrchestrator
        │
        ▼
CredentialBrokerPort.resolve(request)
        │
        ▼
CredentialResolution
  ├── { available: true, references: CredentialReference[], scoped: environment variables }
  └── { available: false, error: "BLOCKED_BY_CREDENTIAL_POLICY" }
```

- The `CredentialBrokerPort` returns **references** or **scoped environment variables** — never raw access to the underlying secret store.
- For V1, the FakeCredentialBroker returns empty credential sets (no credentials needed for local-only execution).
- A credential reference is a token that the runtime/gateway can substitute at the point of use — not a secret the worker process can read.
- No arbitrary permanent secrets may appear in: worker env, prompt, logs, artifacts, workspace files, process arguments.

---

## 10. Network Policy

**Default: DENY**

No worker starts with unrestricted internet access.

### Policy Request

```typescript
interface NetworkRequest {
  tenantId: string;
  missionId: string;
  runId: string;
  requestedEndpoints?: Array<{
    host: string;
    port?: number;
    protocol?: "http" | "https" | "tcp";
  }>;
}
```

### Decision

```typescript
type NetworkDecision =
  | { outcome: "allow"; rules: NetworkPermission[]; scope: "scoped" | "unrestricted" }
  | { outcome: "deny"; reason: string };
```

For V1, the `NetworkPolicyPort` always returns `{ outcome: "deny", reason: "D4 V1: network not configured for worker access" }`.

---

## 11. Agent Runtime Adapter Interface

```typescript
interface AgentRuntimeAdapter {
  readonly name: string;
  execute(input: RuntimeAdapterInput): Promise<RuntimeAdapterResult>;
}
```

### LocalRuntimeAdapter (V1)

The V1 adapter runs steps as local subprocesses with:

- Isolated workspace directory as working directory
- Process group isolation (for clean kill on timeout/cancellation)
- Timeout via `setTimeout` + abort mechanism
- Cancellation via `AbortSignal` subscriber → process group kill
- stdout/stderr captured as artifacts
- AI-backed steps use `AiGatewayPort.generate()` integrated via the orchestrator

Process tree cleanup on timeout/cancellation:
1. Kill process group (negative PID on POSIX)
2. Wait for graceful shutdown (configurable grace period)
3. Force kill if still alive after grace period

---

## 12. Cancellation

D4 owns global execution cancellation.

```
External AbortSignal / timeout
        │
        ▼
ExecutionOrchestrator
  ├── sets internal AbortController
  ├── propagates signal to LocalRuntimeAdapter
  ├── adapter kills process group
  ├── Orchestrator awaits cleanup
  └── final state = CANCELLED | TIMED_OUT
```

- For AI calls, the orchestrator's `AbortSignal` is passed to `AiGatewayPort.generate({ abortSignal })`.
- Cancellation must clean up: AI request, worker process, child processes, runtime state, workspace lease.
- Timeout must terminate the **complete** process tree (not just the root process).
- Cancellation races (signal fires during cleanup) must be handled gracefully.
- No zombie workers.

---

## 13. Timeout

- Each execution has a configurable `timeoutMs` (default 60s).
- Timeout is enforced via `AbortSignal.timeout()` or equivalent mechanism.
- When timeout fires:
  1. Process group is killed
  2. Workspace is cleaned up
  3. Result is returned with `TIMED_OUT` state
- The timeout is for the complete execution, not per-step within the execution.

---

## 14. Artifact Collection

`ArtifactCollector` extracts allowed outputs from the workspace:

- Reads files from the workspace `output/` directory
- Captures stdout/stderr from the process
- All path operations are scoped to the workspace root
- Any file outside the workspace scope is silently skipped (not an error — prevents information leaking from failed traversal attempts)

---

## 15. D3 Error Mapping

| D3 Error Code | D4 Mapping | Runtime Behavior |
|---------------|------------|------------------|
| `PROVIDER_UNAVAILABLE` | `AI_PROVIDER_UNAVAILABLE` | FAILED; no fallback initiated by D4 |
| `RATE_LIMITED` | `AI_RATE_LIMITED` | FAILED; caller may retry |
| `TIMEOUT` | `AI_TIMEOUT` | FAILED; D4 timeout is separate |
| `INVALID_RESPONSE` | `AI_INVALID_RESPONSE` | FAILED; closed |
| `POLICY_BLOCKED` | `AI_POLICY_BLOCKED` | FAILED; no fallback |
| `UNSUPPORTED_CAPABILITY` | `AI_UNSUPPORTED_CAPABILITY` | FAILED |
| `CANCELLED` | `CANCELLED` | CANCELLED; clean cancellation |
| `INTERNAL_ERROR` | `AI_INTERNAL_ERROR` | FAILED; ICOS failure |

D4 decides execution semantics. D3 only reports normalized AI result/error. D4 never initiates provider fallback — that is D3's responsibility (or the caller's).

---

## 16. Usage Metadata

D3 provides:
- `inputTokens`, `outputTokens`, `totalTokens`
- `costUsd?`
- `provider.id`, `provider.model`
- `latencyMs`
- `fallbackUsed`

D4 may persist this metadata according to existing repository architecture. For V1, usage metadata is returned in the `ExecutionResult` and can be stored by the caller (D2). No dedicated usage-storage port is created in V1.

---

## 17. Execution Result / Error Model

```typescript
type ExecutionResult =
  | SuccessfulExecution
  | FailedExecution;

interface SuccessfulExecution {
  ok: true;
  state: "SUCCEEDED";
  output: unknown;
  artifacts: ArtifactItem[];
  usage?: AiUsage;
  latencyMs: number;
}

interface FailedExecution {
  ok: false;
  state: "FAILED" | "CANCELLED" | "TIMED_OUT" | "LOST";
  error: ExecutionError;
}
```

### Execution Error Codes

D4-native (not from D3):
- `POLICY_DENIED` — D1 execution-time policy check denied
- `REQUIRES_APPROVAL` — D1 requires approval before execution
- `CREDENTIAL_UNAVAILABLE` — Credential broker cannot satisfy request
- `NETWORK_BLOCKED` — Network policy denied
- `WORKSPACE_ERROR` — Workspace creation/setup failed
- `WORKSPACE_ESCAPE_DENIED` — Workspace traversal attempt detected
- `PROCESS_ERROR` — Subprocess failed (non-zero exit)
- `TIMEOUT` — Execution exceeded timeout
- `CANCELLED` — Execution was cancelled
- `WORKER_LOST` — Worker process disappeared
- `CLEANUP_ERROR` — Workspace cleanup failed (non-fatal to execution)
- `INTERNAL_ERROR` — Unexpected D4 failure (fail-closed)

D3-mapped:
- `AI_PROVIDER_UNAVAILABLE`
- `AI_RATE_LIMITED`
- `AI_TIMEOUT`
- `AI_INVALID_RESPONSE`
- `AI_POLICY_BLOCKED`
- `AI_UNSUPPORTED_CAPABILITY`
- `AI_INTERNAL_ERROR`

---

## 18. TOCTOU Protection

Read → validate → hash → seal/record expected state → execute

If security-sensitive input/config changes between validation and execution, D4 **must** deny the execution. For V1, this primarily applies to:

1. **Policy state at execution time:** D1 re-check happens immediately before execution, not at planning time. There is no window between re-check and execution start.
2. **Workspace path validation:** Resolve and validate the workspace path immediately before use. If the path was tampered with between validation and creation, deny.
3. **Input hash:** The step input is hashed at reception and verified before the adapter executes. If the hash doesn't match, execution is denied.

---

## 19. Security Acceptance Gates

| ID | Requirement | Verification |
|----|-------------|--------------|
| SEC-D4-01 | Worker cannot obtain raw stored credentials | Test: broker returns references, worker env has no raw secrets |
| SEC-D4-02 | Network default deny | Test: policy without explicit endpoint returns deny |
| SEC-D4-03 | Workspace cannot escape root via `../` | Test: path with `../` beyond root is rejected |
| SEC-D4-04 | Workspace cannot escape via symlink | Test: symlink to outside workspace is denied |
| SEC-D4-05 | Timeout kills complete process tree | Test: process group receives SIGTERM on timeout |
| SEC-D4-06 | Cancellation cannot leave zombie worker | Test: after cancellation, process is reaped |
| SEC-D4-07 | Authorization rechecked immediately before execution | Test: stale allow at planning is overwritten by execution-time recheck |
| SEC-D4-08 | TOCTOU-sensitive hash mismatch denies execution | Test: modified input after validation results in deny |
| SEC-D4-09 | Cleanup cannot delete outside owned workspace | Test: cleanup with escaped path does not delete outside scope |
| SEC-D4-10 | Logs/artifacts cannot expose credential values | Test: credential values are scrubbed from captured output |

---

## 20. Testing Plan

### Core Contracts
- D4-01: successful state progression
- D4-02: invalid state transition rejected
- D4-03: terminal states are immutable

### Policy Integration
- D4-04: D1 DENY prevents execution
- D4-05: D1 REQUIRE_APPROVAL prevents unauthorized execution
- D4-06: authorization is rechecked at execution time (not stale)

### AI Gateway Integration
- D4-07: tenant preserved
- D4-08: correlationId passed to D3
- D4-09: AI generation success mapped correctly
- D4-10: PROVIDER_UNAVAILABLE mapped safely
- D4-11: RATE_LIMITED mapped safely
- D4-12: TIMEOUT mapped correctly
- D4-13: CANCELLED mapped correctly
- D4-14: POLICY_BLOCKED fails closed

### Process & Workspace
- D4-15: worker cancellation
- D4-16: worker timeout
- D4-17: process tree cleanup
- D4-18: workspace traversal denied
- D4-19: symlink escape denied
- D4-20: workspace cleanup safe
- D4-21: network default deny

### Security
- D4-22: raw credential unavailable to worker
- D4-23: credential leakage absent from logs
- D4-24: TOCTOU/hash mismatch denied
- D4-25: artifacts collected only from allowed workspace

### State & Metadata
- D4-26: mission state and runtime state remain distinct
- D4-27: D3 fallback metadata preserved
- D4-28: D3 usage metadata preserved
- D4-29: malformed runtime result fails closed
- D4-30: lost/dead worker represented explicitly

---

## 21. Container Integration

D4 components are wired into the container:

```typescript
// Container additions:
runtime?: RuntimeExecutionPort;
credentialBroker?: CredentialBrokerPort;
networkPolicy?: NetworkPolicyPort;
runtimeExecutionOrchestrator?: ExecutionOrchestrator;
```

- In `buildMemoryContainer`: all fakes, no real process execution
- In `buildPostgresContainer`: same fakes for V1; real process execution uses `LocalRuntimeAdapter`
- The `ExecutionOrchestrator` requires: `D1PolicyPort`, `AiGatewayPort`, `WorkspaceManager`, `ArtifactCollector`, and optionally `CredentialBrokerPort`/`NetworkPolicyPort`

---

## 22. Deferred Items (V1)

- Distributed scheduling
- Remote/VPS adapters
- Docker/container runtime integration
- NemoClaw sandbox integration
- MCP gateway for tool execution
- Advanced credential broker (Vault, AWS Secrets Manager, etc.)
- Network policy implementation with real firewall rules
- Persistent execution history tables
- Streaming execution results
- Multi-step workflow within D4 (D2 handles this)
- Usage/cost aggregation and persistence
- Quota enforcement

---

## 23. Known Limitations

- V1 workspace isolation is filesystem-level only (no Docker/mount namespaces)
- Credential broker returns empty set — credentials are not consumed in V1 local-only mode
- Network policy always denies — no outbound connections from worker processes
- No remote execution support
- No multi-tenant process isolation beyond PID namespaces
- Process tree cleanup relies on process groups; children that create new process groups may escape
- Artifact collection is file-based only; no streaming output capture
- TOCTOU protection uses input hashing — adequate for V1 but not cryptographic-grade attestation
