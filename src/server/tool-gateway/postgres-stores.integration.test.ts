import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rowToAuditEntry } from "@/server/database/mappers";
import { auditEntries } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  type PgContext,
} from "@/server/database/testing/pg-support";
import {
  toolApprovalRequests,
  toolExecutions,
  toolGrants,
} from "@/server/database/tool-gateway-schema";

import { defineGatewayProofs } from "./gateway-proofs";
import {
  PostgresToolApprovalStore,
  PostgresToolExecutionStore,
  PostgresToolGrantStore,
} from "./postgres-stores";
import { SECRET, TENANT_A, caller, makeHarness } from "./test-fixtures";

/**
 * Real PostgreSQL proofs (Testcontainers, migrations applied from zero).
 * The same 15 proofs as the unit suite, plus what only a database can prove.
 */
describe.skipIf(!dockerAvailable)("Tool Gateway on PostgreSQL", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
  });
  afterAll(async () => {
    await stopPostgres(ctx);
  });

  const reset = () =>
    ctx.handle.db.execute(
      sql`TRUNCATE TABLE tool_approval_requests, tool_executions, tool_grants, audit_entries CASCADE`,
    );
  const pgHarness = async () => {
    await reset();
    const db = ctx.handle.db;
    return makeHarness({
      executions: new PostgresToolExecutionStore(db),
      approvals: new PostgresToolApprovalStore(db),
      grants: new PostgresToolGrantStore(db),
    });
  };

  defineGatewayProofs("postgres", pgHarness, async () =>
    (await ctx.handle.db.select().from(auditEntries)).map(rowToAuditEntry),
  );

  it("schema parity: every Drizzle column exists in the migrated database", async () => {
    for (const table of [toolExecutions, toolApprovalRequests, toolGrants]) {
      const rows = await ctx.handle.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = ${getTableName(table)}`;
      const actual = rows.map((r) => r.column_name).sort();
      const expected = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
      expect(actual).toEqual(expected);
    }
  });

  it("two gateway processes racing on one key dispatch the side effect once", async () => {
    const h1 = await pgHarness();
    await h1.grant("agent-1", "mail", "CREATE");
    const db = ctx.handle.db;
    const h2 = makeHarness({
      executions: new PostgresToolExecutionStore(db),
      approvals: new PostgresToolApprovalStore(db),
      grants: new PostgresToolGrantStore(db),
    });
    h2.connector.effects = h1.connector.effects; // one provider, two ICOS processes
    const intent = {
      toolId: "mail",
      action: "CREATE",
      connectorInstanceId: "inst-a",
      input: { to: "x@example.com" },
      idempotencyKey: "race-key-001",
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? h1 : h2).gateway.execute(caller(), intent)),
    );
    expect(results.some((r) => r.kind === "succeeded")).toBe(true);
    expect(results.every((r) => r.kind === "succeeded" || r.kind === "in_progress")).toBe(true);
    expect(h1.connector.effects.get("race-key-001")).toBe(1);
    const [{ n }] = await ctx.handle.sql<{ n: number }[]>`
      select count(*)::int as n from tool_executions where idempotency_key = 'race-key-001'`;
    expect(n).toBe(1);
  });

  it("the database itself refuses a duplicate key, a tenant-less row and an agent-decided HIGH approval", async () => {
    const h = await pgHarness();
    await h.grant("agent-1", "mail", "SEND");
    const r = await h.gateway.execute(caller(), {
      toolId: "mail",
      action: "SEND",
      connectorInstanceId: "inst-a",
      input: { to: "x@example.com" },
      idempotencyKey: "db-key-00001",
    });
    expect(r.kind).toBe("approval_required");
    const s = ctx.handle.sql;
    await expect(
      s`insert into tool_executions select (id || '-dup') as id, tenant_id, idempotency_key, request_fingerprint,
          tool_id, tool_version, action, connector_instance_id, requester_agent_id, mission_id, task_id,
          risk_class, side_effects, status, settlement_state, approval_request_id, attempt_count,
          provider_operation_id, failure_class, failure_message, result_summary, result_reference,
          audit_references, version, created_at, started_at, finished_at, updated_at
        from tool_executions where idempotency_key = 'db-key-00001'`,
    ).rejects.toThrow(/tool_executions_tenant_key_unique/);
    await expect(
      s`update tool_executions set tenant_id = '' where idempotency_key = 'db-key-00001'`,
    ).rejects.toThrow(/tool_executions_tenant_check/);
    await expect(
      s`update tool_executions set status = 'SUCCEEDED' where idempotency_key = 'db-key-00001'`,
    ).rejects.toThrow(/tool_executions_success_settlement_check/);
    await expect(
      s`update tool_approval_requests set status = 'APPROVED', decided_by_kind = 'agent', decided_by_id = 'agent-1', decided_at = now()`,
    ).rejects.toThrow(/tool_approval_human_for_high_check/);
  });

  it("no stored row or audit entry contains the secret", async () => {
    const h = await pgHarness();
    await h.grant("agent-1", "mail", "READ");
    h.connector.mode = "echo_secret";
    expect(
      (
        await h.gateway.execute(caller(), {
          toolId: "mail",
          action: "READ",
          connectorInstanceId: "inst-a",
          input: {},
        })
      ).kind,
    ).toBe("succeeded");
    h.connector.mode = "throw";
    await h.gateway.execute(caller(), {
      toolId: "mail",
      action: "READ",
      connectorInstanceId: "inst-a",
      input: {},
    });
    const dump = await ctx.handle.sql<{ t: string }[]>`
      select row_to_json(e)::text as t from tool_executions e
      union all select row_to_json(a)::text from tool_approval_requests a
      union all select row_to_json(g)::text from tool_grants g
      union all select row_to_json(x)::text from audit_entries x`;
    expect(dump.length).toBeGreaterThan(0);
    expect(dump.map((r) => r.t).join("\n")).not.toContain(SECRET);
    expect((await h.executions.list(TENANT_A)).length).toBe(2);
  });
});
