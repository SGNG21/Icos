# 0055 — Tools are requested by agents and decided by the gateway

- Status: accepted
- Date: 2026-09-29
- Lane: `feat/tool-gateway-connectors`

## Context

ICOS must let agents use external tools (email, CRM, files, GitHub, HTTP APIs, MCP…) without
letting a model decide its own permissions, leak a credential, or repeat a side effect on retry.

Audit of the committed state (`e652469`):

| Existing | Finding | Decision |
|---|---|---|
| `core/contracts/tool-definition.ts`, `tool-call.ts` | Conceptual stubs, **no caller** | Removed; replaced by the canonical model |
| `core/contracts/tool-gateway.ts` | Conceptual stub, governance-protected path | Kept as the entry point; re-exports the canonical model |
| `core/authorization/decide.ts` (`decideExecution`) | Kernel risk/approval floor | **Reused** as the floor of every tool decision |
| `core/identity/permissions.ts` (`hasPermission`) | Human permission matrix | **Reused**: `approvals.decide` to approve, `agentCapabilities.write` to grant |
| `audit_entries` + `AuditEntry` | Canonical append-only audit | **Reused**: four `tool.*` event types, written in the same transaction as each state change |
| `core/memory/rules.ts` (`containsSecret`) | Secret detector | **Reused** on tool input and persisted summaries |
| `actions` / `approvals` tables | Human approval of agent actions | Not reused for tools: no tenant, no expiry, no binding to a request payload, no create path. Tool approvals get their own tenant-scoped, expiring, fingerprint-bound store; the decision authority (a human with `approvals.decide`) is the same |
| MCP, connectors, credential resolver | None exist | New |

## Decision

One canonical gateway: `src/core/tool-gateway/` (pure model + policy) and
`src/server/tool-gateway/` (service, ports, stores, connectors).

```
ToolIntent (model, strict) → ToolGateway(caller: tenant + agent, resolved server-side)
  → decideToolRequest: tenant → connector availability/health → explicit grant
      → kernel decideExecution → approval
  → [ToolApprovalRequest → human decision]
  → claim (tenant, idempotencyKey) → CAS dispatch → CredentialResolver → Connector
  → settle (APPLIED / NOT_APPLIED / UNKNOWN) → evidence + audit (one transaction)
```

1. **Action classes are independent permissions.** A grant is exact:
   (tenant, agent, tool, action). No wildcard, no hierarchy: READ ⇏ WRITE ⇏ DELETE,
   CREATE (draft) ⇏ SEND, READ ⇏ MERGE. A role's requirements are reported by
   `checkCapabilities` as `granted`/`missing`; nothing is ever granted implicitly.
2. **Risk.** LOW/MEDIUM/HIGH/CRITICAL map onto the kernel's
   `read_only`/`reversible`/`sensitive`/`sensitive`. HIGH and CRITICAL always need a
   **human** approval (kernel rule for `sensitive`); a definition can only tighten this.
   MEDIUM may declare `human_or_agent`, with self-approval only if explicitly allowed. The
   database refuses an agent decision on a HIGH/CRITICAL approval row.
3. **Approvals** are bound to one request fingerprint (sha256 of tenant, tool, action,
   instance and canonical input), expire (pending: deadline to decide; approved: deadline to
   use), and a rejection is terminal for that request.
4. **Idempotency.** Any external, approval-gated or HIGH+ action is `key_required`
   (schema-enforced). `UNIQUE (tenant_id, idempotency_key)` + a `version` compare-and-set
   make exactly one dispatch possible per key, across processes. Same key + different
   payload → `IDEMPOTENCY_CONFLICT`. A retry of a settled request replays its evidence.
   An `UNKNOWN` settlement is never re-dispatched: only reconciliation (by idempotency key /
   provider operation id) can settle it; if the connector cannot reconcile, it stays
   `SETTLEMENT_UNKNOWN` (fail closed, visible in the Cockpit `unsettled` list).
5. **Credentials.** Models see `credentialRef` only. The resolver returns a `SecretValue`
   whose every serialisation is `[REDACTED]`; it is handed to the connector only. Outputs,
   messages and summaries are scrubbed of the value; credential-shaped input is refused.
   No table has a secret column.
6. **Failure classes** are normalised (`AUTH_FAILURE` … `UNKNOWN`, plus `APPROVAL_EXPIRED`,
   `SETTLEMENT_UNKNOWN`, `NOT_CONNECTED`) with an exhaustive retryability table.
7. **Tenant isolation** is application-enforced: `tenant_id` NOT NULL and non-empty on every
   table, in every unique key, and a mandatory predicate of every store method; connector
   instances and credential references belong to one tenant; a foreign instance is
   indistinguishable from a missing one.
8. **Connectors** are provider-neutral adapters (`health`, `execute`, optional
   `reconcile`/`cancel`) with no business rules. Real in this repository: `local-files`
   (root-confined, symlink-safe) and `http` (base-origin-confined, no redirects,
   `Idempotency-Key` forwarded). Every other category is defined (actions, risks,
   credentials) but `NOT_CONNECTED` and refuses execution.

## Ports for other lanes

- Cognitive Runtime: `ToolGatewayPort.execute(caller, intent, { onProgress })` →
  `succeeded | approval_required | in_progress | failed(failureClass, retryable)` + audit refs.
- Digital Workforce: `checkCapabilities(caller, requirements)` → `{ granted, missing }`.
- Cockpit: `cockpitSnapshot(tenantId)` (health, pending approvals, executions, failures,
  blocked, side effects, unsettled) and `inventory(caller)`.

## Consequences

- Migration `0049_tool_gateway` (additive; widens `audit_event_type_check`).
- Not yet wired into the container, HTTP routes or the Cockpit UI (next lane step).
- Connector-instance health and rate-limit windows are per process (documented ceiling).
- Postgres RLS is not introduced (repo-wide COMPLIANCE-1 item); isolation is enforced in
  the store layer and proven by tests.
