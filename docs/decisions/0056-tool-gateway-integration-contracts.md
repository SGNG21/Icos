# 0056 — The Tool Gateway is composed once, audits every refusal, and treats connector output as data

- Status: accepted
- Date: 2026-09-30
- Lane: `feat/tool-gateway-connectors` (follows 0055)

## Context

Decision 0055 established the governed gateway. Its known gaps blocked integration:

- declared input schemas were not enforced;
- refusals before an execution row existed left no evidence;
- the same operation under a new idempotency key could repeat a side effect;
- connector health lived in process memory and was assumed at registration;
- there was no approval or grant boundary for humans;
- connector output reached callers unlabelled;
- the approval-to-execution FK ignored the tenant.

## Decision

1. **Composition.** `composeToolGateway` (`src/server/tool-gateway/composition.ts`) is the only
   factory. It takes the integrator's shared agent lookup, audit repository and database handle,
   and returns:
   - `gateway`, `registry`, `credentials`;
   - the four stores;
   - `audit`, which is the same object that was passed in;
   - the pure `policy` functions;
   - `reconciliation`.

   Deployment configuration holds no secret: credentials are bound by environment-variable
   name. The routes reach the runtime through `src/server/tool-gateway/app.ts`, so the shared
   `container.ts` stays untouched.

2. **Input schemas are enforced by the gateway.** Every action's JSON `inputSchema` is compiled
   once, at construction, with `zod.fromJSONSchema`; an uncompilable schema fails composition. A
   non-conforming input becomes a `DENIED / INVALID_INPUT` execution row with its audit entry.
   The error records paths only, never values, and no connector is called.
3. **Every refusal is evidence.** Refusals before claim are appended to the canonical audit as
   `tool.request.denied`, with a closed `details.reason`:
   - `INVALID_INTENT`
   - `UNKNOWN_CONNECTOR_INSTANCE`
   - `FOREIGN_CONNECTOR_INSTANCE`
   - `UNKNOWN_TOOL`
   - `MISSING_IDEMPOTENCY_KEY`
   - `IDEMPOTENCY_KEY_OF_ANOTHER_REQUESTER`
   - `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`
   - `PERMISSION_DENIED`

   Only validated identifiers are recorded, never input. Refusals after claim (`POLICY_DENIED`,
   `PERMISSION_DENIED`, `INVALID_INPUT`, `APPROVAL_REQUIRED`, `DUPLICATE_OPERATION`) are the
   execution row plus its audit entry, written in one transaction. The caller sees the same answer
   for an unknown instance and for another tenant's instance; the audit tells them apart.

4. **Duplicate operations.**
   - The `operationFingerprint` is sha256 of (tenant, tool, action, instance, input); unlike
     `requestFingerprint`, it has no requester.
   - A per-action `duplicatePolicy` of `allow`, `block` or `require_override`, with a window,
     applies when another execution of the same operation is live (awaiting approval, executing,
     applied, or unknown) inside the window under a different key.
   - Resolution order: deployment override (`toolId:ACTION`), then definition, then default. The
     default is `require_override` over 24 h for SEND, PUBLISH, DEPLOY, DELETE, PURCHASE, PAY,
     GRANT_ACCESS and REVOKE_ACCESS when they have side effects, and `allow` for everything else,
     so drafts and reads repeat freely.
   - An override must name the prior execution id and give a reason. It is recorded as
     `duplicateOf` on the execution and the approval request, so the approver sees that the
     action repeats an earlier one.
   - The check runs before an approval is requested and again just before dispatch. It is
     best-effort under true concurrency: two new keys racing in the same instant can both pass.
     The idempotency key is the strict guarantee.
5. **Approvals are single-use.** Only the winner of the dispatch compare-and-set consumes the
   approval (`consumedAt`, audited as `tool.approval.consumed`). A retry after a not-applied
   failure needs a new approval.
6. **Health is dated, expirable evidence** (decision 0033 applied to connectors), stored in
   `tool_connector_health`:
   - Missing or stale evidence reads UNKNOWN, and a lapsed throttle also reads UNKNOWN. A disabled
     instance is DISABLED.
   - Nothing is HEALTHY until a probe says so, and a restart reads the same evidence.
   - `ToolReconciliationService.runOnce` probes health and settles orphaned or unknown side effects
     for every tenant. It runs at boot. It is exposed as a `JobHandler` for the existing Durable
     Scheduler; registering a new `ScheduledJobKind` belongs to the scheduler lane.
7. **Human boundary.** The routes under `/api/tool-gateway/*` use `protectRoute`:
   - approvals list and decide: `approvals.decide`;
   - grants inspect: `agentCapabilities.read`;
   - grants mutate: `agentCapabilities.write`;
   - cockpit: `cockpit.read`.

   The principal is always the session, and bodies are strict, so identity cannot be forged. A
   grant carries its grantor and a reason; revocation is soft and keeps who, when and why. Agents
   hold no session, so they cannot grant or approve HIGH/CRITICAL actions.

8. **Trust boundary.** Connector output is returned as `UntrustedToolResult`:
   - `trust: "UNTRUSTED_EXTERNAL_DATA"`;
   - the source connector, instance, tool and action;
   - the execution id;
   - the tenant scope;
   - the content type;
   - `data`.

   `resultTrust` is persisted on the row. The gateway never reads connector output as policy,
   grant, approval or intent. The only instruction channel is a new `ToolIntent`, decided afresh.
   Connectors get copies of the instance and input, so they cannot rewrite their configuration.

9. **Tenant readiness without a fake tenancy.** `tool_approval_requests (tenant_id,
tool_execution_id)` references `tool_executions (tenant_id, id)`. The runtime still uses the
   single-tenant shim (`toolTenantOf()`).

## Blocked on COMPLIANCE-1

- Resolving the acting tenant from the session and verifying membership. Today `toolTenantOf()`
  returns `CURRENT_SINGLE_TENANT_ID`; it is not a membership check.
- Tenant-scoped human roles for approving and granting.
- Row-level security. Isolation remains application-enforced plus tenant-composite keys.

## Consequences

- The `audit_event_type_check` is widened again (six `tool.*` values). See
  `docs/icos/tool-gateway-migration-manifest.md` for the required union with the control-plane
  migration.
- The integrator wires `composeToolGateway` into the container and registers the reconciliation
  job kind.
