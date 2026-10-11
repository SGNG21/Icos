import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";

import {
  PostgresConnectorHealthStore,
  PostgresToolApprovalStore,
  PostgresToolExecutionStore,
  PostgresToolGrantStore,
} from "./postgres-stores";
import { SECRET, TENANT_A, caller, makeHarness, type Harness } from "./test-fixtures";

/**
 * CHAOS — TOOL FAILURE AND TOOL TIMEOUT through `ToolGateway.execute`, on PostgreSQL.
 *
 * The unit/proof suites cover auth failure (P10), rate limit (P11) and an applied-then-crash
 * write (P13). What they did not pin down is the plain FAILING and HANGING connector:
 *   - a connector that throws, or that never answers, yields a deterministic ToolFailureClass;
 *   - the settlement and its audit evidence are durable rows, with no secret in them;
 *   - the caller retrying does not become a retry storm: a side-effecting call whose outcome is
 *     UNKNOWN is reconciled with the provider before any re-dispatch and applied once, and an
 *     effect-free one is dispatched once per request — the gateway never retries on its own.
 *
 * Double: the connector (the provider edge). Stores and audit are the production Postgres ones.
 */

let handle: DatabaseHandle;
let h: Harness;
let calls: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  handle = createDatabase(TEST_DATABASE_URL, { max: 4 });
});
afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.execute(
    sql`TRUNCATE TABLE tool_approval_requests, tool_executions, tool_grants, tool_connector_health, audit_entries CASCADE`,
  );
  h = await makeHarness({
    executions: new PostgresToolExecutionStore(handle.db),
    approvals: new PostgresToolApprovalStore(handle.db),
    grants: new PostgresToolGrantStore(handle.db),
    health: new PostgresConnectorHealthStore(handle.db),
    audit: new PostgresAuditRepository(handle.db),
  });
  calls = vi.spyOn(h.connector, "execute");
});

const intent = (action: "READ" | "CREATE", key: string) => ({
  toolId: "mail",
  action,
  connectorInstanceId: "inst-a",
  input: action === "READ" ? {} : { to: "x@example.com" },
  idempotencyKey: key,
});

async function executionRow(key: string) {
  const [row] = (await handle.db.execute(
    sql`select status, settlement_state, failure_class, attempt_count from tool_executions where idempotency_key = ${key}`,
  )) as unknown as Array<Record<string, unknown>>;
  return row;
}
async function auditFor(toolExecutionId: string) {
  return (await handle.db.execute(
    sql`select event_type, details::text as details from audit_entries where details->>'toolExecutionId' = ${toolExecutionId} order by occurred_at, created_at`,
  )) as unknown as Array<{ event_type: string; details: string }>;
}

describe("CHAOS — tool failure / tool timeout through the gateway (PostgreSQL)", () => {
  it("TOOL FAILURE: a throwing connector is classified, audited durably, secret-free, dispatched once", async () => {
    await h.grant("agent-1", "mail", "READ");
    h.connector.mode = "throw"; // throws `boom <SECRET>`
    const r = await h.gateway.execute(caller(), intent("READ", "chaos-throw-0001"));

    expect(r).toMatchObject({ kind: "failed", failureClass: "UNKNOWN" });
    expect(calls).toHaveBeenCalledTimes(1);
    const row = await executionRow("chaos-throw-0001");
    /* Effect-free action: a failure cannot have applied anything. */
    expect(row).toMatchObject({ status: "FAILED", settlement_state: "NOT_APPLIED", failure_class: "UNKNOWN", attempt_count: 1 });
    const audit = await auditFor(r.toolExecutionId!);
    expect(audit.map((a) => a.event_type)).toContain("tool.execution.recorded");
    expect(audit.length).toBeGreaterThanOrEqual(2);
    for (const a of audit) expect(a.details).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("TOOL TIMEOUT (read): a hanging connector settles TIMEOUT within its budget, retryable, audited", async () => {
    await h.grant("agent-1", "mail", "READ");
    h.connector.mode = "hang";
    const t0 = Date.now();
    const r = await h.gateway.execute(caller(), intent("READ", "chaos-hang-r-001"));
    const elapsed = Date.now() - t0;

    /* The fixture tool's timeoutMs is 1000. */
    expect(elapsed).toBeLessThan(5_000);
    expect(r).toMatchObject({ kind: "failed", failureClass: "TIMEOUT", retryable: true });
    expect(await executionRow("chaos-hang-r-001")).toMatchObject({
      status: "FAILED",
      settlement_state: "NOT_APPLIED",
      failure_class: "TIMEOUT",
      attempt_count: 1,
    });
    expect((await auditFor(r.toolExecutionId!)).length).toBeGreaterThanOrEqual(2);
  });

  it("TOOL TIMEOUT (side effect) + RETRY STORM: UNKNOWN is reconciled before any re-dispatch; nine retries apply the effect once", async () => {
    await h.grant("agent-1", "mail", "CREATE");
    h.connector.mode = "hang";
    const first = await h.gateway.execute(caller(), intent("CREATE", "chaos-hang-w-001"));
    /* A timed-out WRITE may have applied: UNKNOWN settlement, and NOT blindly retryable. */
    expect(first).toMatchObject({ kind: "failed", failureClass: "TIMEOUT", retryable: false });
    expect(await executionRow("chaos-hang-w-001")).toMatchObject({ settlement_state: "UNKNOWN", attempt_count: 1 });

    /* The provider recovers; the caller hammers the same request — once, then eight at once. */
    h.connector.mode = "ok";
    const reconcile = vi.spyOn(h.connector, "reconcile");
    const retries = [
      await h.gateway.execute(caller(), intent("CREATE", "chaos-hang-w-001")),
      ...(await Promise.all(
        Array.from({ length: 8 }, () => h.gateway.execute(caller(), intent("CREATE", "chaos-hang-w-001"))),
      )),
    ];
    /* The gateway asked the provider what happened BEFORE dispatching again. */
    expect(reconcile).toHaveBeenCalled();
    expect(retries[0]!.kind).toBe("succeeded");
    for (const r of retries) expect(["succeeded", "in_progress"]).toContain(r.kind);
    /* Two dispatches in total (the hung one, the reconciled re-dispatch), ONE provider effect, one row. */
    expect(calls).toHaveBeenCalledTimes(2);
    expect(h.connector.effectCount()).toBe(1);
    expect(h.connector.effects.get("chaos-hang-w-001")).toBe(1);
    const [{ n }] = (await handle.db.execute(
      sql`select count(*)::int as n from tool_executions where idempotency_key = 'chaos-hang-w-001'`,
    )) as unknown as Array<{ n: number }>;
    expect(n).toBe(1);
    expect(await executionRow("chaos-hang-w-001")).toMatchObject({ status: "SUCCEEDED", settlement_state: "APPLIED", attempt_count: 2 });
  });

  it("REPEATED FAILING REQUESTS: each new request is dispatched exactly once — the gateway itself never retries", async () => {
    await h.grant("agent-1", "mail", "READ");
    h.connector.mode = "throw";
    for (let i = 0; i < 5; i += 1) {
      const r = await h.gateway.execute(caller(), intent("READ", `chaos-rep-${String(i).padStart(4, "0")}`));
      expect(r).toMatchObject({ kind: "failed", failureClass: "UNKNOWN" });
    }
    expect(calls).toHaveBeenCalledTimes(5);
    const rows = (await handle.db.execute(
      sql`select attempt_count from tool_executions where tenant_id = ${TENANT_A} and idempotency_key like 'chaos-rep-%'`,
    )) as unknown as Array<{ attempt_count: number }>;
    expect(rows.map((r) => r.attempt_count)).toEqual([1, 1, 1, 1, 1]);
  });
});
