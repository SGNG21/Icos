import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/server/database/client";
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
  toolConnectorHealth,
  toolExecutions,
  toolGrants,
} from "@/server/database/tool-gateway-schema";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";

import { defineGatewayProofs } from "./gateway-proofs";
import {
  PostgresConnectorHealthStore,
  PostgresToolApprovalStore,
  PostgresToolExecutionStore,
  PostgresToolGrantStore,
} from "./postgres-stores";
import { SECRET, TENANT_A, caller, makeHarness, type HarnessStores } from "./test-fixtures";

/**
 * Real PostgreSQL proofs (Testcontainers, migrations applied from zero).
 * The same proofs as the unit suite — with the CANONICAL audit repository as
 * the audit port — plus what only a database can prove.
 */
const pgStores = (db: Database): HarnessStores => ({
  executions: new PostgresToolExecutionStore(db),
  approvals: new PostgresToolApprovalStore(db),
  grants: new PostgresToolGrantStore(db),
  health: new PostgresConnectorHealthStore(db),
  audit: new PostgresAuditRepository(db),
});

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
      sql`TRUNCATE TABLE tool_approval_requests, tool_executions, tool_grants, tool_connector_health, audit_entries CASCADE`,
    );
  const pgHarness = async () => {
    await reset();
    return makeHarness(pgStores(ctx.handle.db));
  };
  const read = { toolId: "mail", action: "READ", connectorInstanceId: "inst-a", input: {} };

  defineGatewayProofs("postgres", pgHarness, async () =>
    (await ctx.handle.db.select().from(auditEntries)).map(rowToAuditEntry),
  );

  it("schema parity: every Drizzle column exists in the migrated database", async () => {
    for (const table of [toolExecutions, toolApprovalRequests, toolGrants, toolConnectorHealth]) {
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
    const h2 = await makeHarness(pgStores(ctx.handle.db));
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

  it("the database refuses a duplicate key, a tenant-less row, an agent-decided HIGH approval and a cross-tenant approval", async () => {
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
      s`insert into tool_executions (id, tenant_id, idempotency_key, request_fingerprint, operation_fingerprint,
          tool_id, tool_version, action, connector_instance_id, requester_agent_id, risk_class, side_effects,
          status, settlement_state, attempt_count, audit_references, version, created_at, updated_at)
        select id || '-dup', tenant_id, idempotency_key, request_fingerprint, operation_fingerprint,
          tool_id, tool_version, action, connector_instance_id, requester_agent_id, risk_class, side_effects,
          status, settlement_state, attempt_count, audit_references, version, created_at, updated_at
        from tool_executions where idempotency_key = 'db-key-00001'`,
    ).rejects.toThrow(/tool_executions_tenant_key_unique/);
    await expect(
      s`update tool_executions set status = 'SUCCEEDED' where idempotency_key = 'db-key-00001'`,
    ).rejects.toThrow(/tool_executions_success_settlement_check/);
    await expect(
      s`update tool_approval_requests set status = 'APPROVED', decided_by_kind = 'agent', decided_by_id = 'agent-1', decided_at = now()`,
    ).rejects.toThrow(/tool_approval_human_for_high_check/);
    // An approval can never point at another tenant's execution (tenant-composite FK).
    await expect(s`update tool_approval_requests set tenant_id = 'tenant-b'`).rejects.toThrow(
      /tool_approval_execution_fk/,
    );
    await expect(s`update tool_approval_requests set consumed_at = now()`).rejects.toThrow(
      /tool_approval_consumed_check/,
    );
    await expect(s`update tool_grants set revoked_at = now()`).rejects.toThrow(
      /tool_grants_revocation_check/,
    );
  });

  it("health evidence survives a restart and is shared by every process", async () => {
    const h1 = await pgHarness();
    await h1.grant("agent-1", "mail", "READ");
    h1.connector.mode = "auth";
    expect(await h1.gateway.execute(caller(), read)).toMatchObject({
      failureClass: "AUTH_FAILURE",
    });
    // A second process (no boot probe) reads the AUTH_FAILED evidence and refuses too.
    const h2 = await makeHarness(pgStores(ctx.handle.db), { skipBootProbe: true });
    h2.connector.mode = "ok";
    expect(await h2.gateway.execute(caller(), read)).toMatchObject({
      failureClass: "AUTH_FAILURE",
    });
    // A fresh database (no evidence at all): the gateway probes before dispatching and
    // obeys the probe — a failing probe is UNKNOWN (refused), never an assumed HEALTHY.
    await ctx.handle.db.execute(sql`TRUNCATE TABLE tool_connector_health`);
    h2.connector.health = async () => {
      throw new Error("probe crashed");
    };
    expect(await h2.gateway.execute(caller(), read)).toMatchObject({
      failureClass: "PROVIDER_UNAVAILABLE",
    });
    h2.connector.health = async () => "HEALTHY";
    await h2.gateway.probeHealth(TENANT_A);
    expect((await h2.gateway.execute(caller(), read)).kind).toBe("succeeded");
  });

  it("no stored row or audit entry contains the secret", async () => {
    const h = await pgHarness();
    await h.grant("agent-1", "mail", "READ");
    h.connector.mode = "echo_secret";
    expect((await h.gateway.execute(caller(), read)).kind).toBe("succeeded");
    h.connector.mode = "throw";
    await h.gateway.execute(caller(), read);
    await h.gateway.execute(caller(), { ...read, connectorInstanceId: "inst-b" }); // audited denial
    const dump = await ctx.handle.sql<{ t: string }[]>`
      select row_to_json(e)::text as t from tool_executions e
      union all select row_to_json(a)::text from tool_approval_requests a
      union all select row_to_json(g)::text from tool_grants g
      union all select row_to_json(c)::text from tool_connector_health c
      union all select row_to_json(x)::text from audit_entries x`;
    expect(dump.length).toBeGreaterThan(0);
    expect(dump.map((r) => r.t).join("\n")).not.toContain(SECRET);
    expect((await h.executions.list(TENANT_A)).length).toBe(2);
  });
});
