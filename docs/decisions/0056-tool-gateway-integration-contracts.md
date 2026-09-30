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

## Independent review (security) — applied

- The provider's `Retry-After` is clamped to 1 s – 1 h, and health bookkeeping after dispatch can
  never throw past the settlement transition (it had been able to leave a 429 as an
  `EXECUTING`/UNKNOWN row).
- Reconciliation queries orphaned `EXECUTING` rows separately from unsettled failures, so they
  cannot be starved. It also no longer rewrites an already-`SETTLEMENT_UNKNOWN` row that is still
  unresolvable, which had produced one new version and one audit entry per run.
- Size budgets are measured in UTF-8 bytes, at half of each DB CHECK (`jsonb::text` spacing is at
  most ×2). A store failure while recording an approval request becomes an audited denial.
- Missing or expired health evidence triggers a real probe of that instance before a dispatch
  decision, so a gateway whose scheduler job is not yet registered does not go dead after one TTL.
  The probe's answer decides; nothing is assumed.
- The memory backend writes to the same shared audit port as Postgres.
- Refused approval decisions and grant changes are audited (`APPROVAL_DECISION_REFUSED`,
  `GRANT_CHANGE_REFUSED`).
- A duplicate refusal names the prior execution only to its own requester.
- A configured instance credential is always resolved (http optional-auth).
- Credential bindings are restricted to `ICOS_TOOL_CRED_*` environment variables.
- local-files maps `ERR_FS_EISDIR` to a not-applied refusal.

Accepted gaps, recorded:

- Duplicate detection is best-effort. Two new keys racing between the check and the CAS can both
  dispatch; an input varied in an ignored field is a different operation where the declared
  schema is open; an override on an action without approval is not escalated to a human. Today
  every connected `require_override` action is HIGH, so a human approves it anyway.
- Re-granting clears the revocation columns; the history remains in the audit.
- Connector failure text is returned as a message without an untrusted label.
- Concurrent retries can leave an orphan PENDING approval request.
- The audit CHECK swap validates under an ACCESS EXCLUSIVE lock.
