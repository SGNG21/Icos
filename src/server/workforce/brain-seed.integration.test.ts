import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BRAIN_IDS, BRAIN_ROLES, CHIEF_BRAIN_ID } from "@/core/workforce/brains";
import { requiredRoleTests } from "@/core/workforce/role-composer";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import { seedBrains } from "./brain-seed";
import { PostgresWorkforceStore } from "./postgres-workforce-store";
import { bootstrap, certifier, makeService, owner } from "./test-support";
import type { WorkforceService } from "./workforce-service";

/**
 * PostgreSQL proof of the brain seed (migration 0051, decisions 0057 / 0066). What only a real
 * database can show: the (tenant_id, role_id, role_version) FK to `workforce_roles` is
 * satisfied, the supervisor self-FK is satisfied because `brain-chief` is inserted first, and
 * the second run is a NO-OP rather than twelve unique-violation errors.
 *
 * `pnpm test` does not run this file (excluded by vitest.config.ts); the coordinator runs it.
 *
 * HARNESS: the LOCAL test database (`ICOS_TEST_DATABASE_URL`), NOT Testcontainers. The
 * `describe.skipIf(!dockerAvailable)` pattern silently skipped 13 integration files for a whole
 * session, so durability was never actually proven. `createDatabase` applies
 * `assertSafeTestDatabaseUrl` under VITEST, so the live database stays unreachable from here.
 */

const WORKFORCE_TABLES = sql`TRUNCATE workforce_events, workforce_performance_observations, workforce_assignments, workforce_agents, workforce_departments, workforce_roles, workforce_skills`;

/** SQLSTATE of a promise PostgreSQL rejected, without exposing the raw message. */
const pgCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "UNKNOWN";
  }
};

describe("seedBrains (base de test locale, migration 0051)", () => {
  let handle: DatabaseHandle;
  let service: WorkforceService;
  let store: PostgresWorkforceStore;

  beforeAll(() => {
    handle = createDatabase(TEST_DATABASE_URL, { max: 5 });
  });
  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.execute(WORKFORCE_TABLES);
    store = new PostgresWorkforceStore(handle.db);
    ({ service } = makeService(store));
  });

  async function activateBrainRoles() {
    await service.seedBootstrap(owner, bootstrap);
    for (const { roleId, version } of BRAIN_ROLES) {
      const role = bootstrap.roles.find((r) => r.roleId === roleId && r.version === version)!;
      await service.certifyRole(
        certifier,
        roleId,
        version,
        requiredRoleTests(role, bootstrap.skills),
      );
      await service.activateRole(owner, roleId, version);
    }
  }

  const rowCount = async () => {
    const rows = (await handle.db.execute(
      sql`select count(*)::int as n from workforce_agents where tenant_id = ${owner.tenantId}`,
    )) as unknown as { n: number }[];
    return rows[0].n;
  };

  it("inserts the twelve brains against the real FKs, and the second run is a no-op", async () => {
    await activateBrainRoles();

    const first = await seedBrains({ service, store }, owner);
    expect(first.complete).toBe(true);
    expect(first.results.map((r) => r.outcome)).toEqual(BRAIN_IDS.map(() => "created"));
    expect(await rowCount()).toBe(12);

    // A NEW store instance: the twelve are read back from the database, not from memory.
    const reread = new PostgresWorkforceStore(handle.db);
    const chief = await reread.getAgent(owner.tenantId, CHIEF_BRAIN_ID);
    expect(chief).toMatchObject({ depth: 0, supervisorAgentId: null, status: "active" });
    expect(chief?.policy.toolGrants).toEqual([]);

    const second = await seedBrains({ service: makeService(reread).service, store: reread }, owner);
    expect(second.complete).toBe(true);
    expect(second.results.every((r) => r.outcome === "already-present")).toBe(true);
    expect(await rowCount()).toBe(12);
  });

  it("the database itself would refuse a second insert: idempotence is not an accident", async () => {
    await activateBrainRoles();
    await seedBrains({ service, store }, owner);

    const chief = (await store.getAgent(owner.tenantId, CHIEF_BRAIN_ID))!;
    expect(await pgCode(store.insertAgent(chief))).toBe("23505");
  });

  it("refuses the whole seed, and writes no agent row, while the reused roles are DRAFT", async () => {
    await service.seedBootstrap(owner, bootstrap);

    const report = await seedBrains({ service, store }, owner);
    expect(report.complete).toBe(false);
    expect(report.results[0].violations).toEqual(["ROLE_NOT_ACTIVE"]);
    expect(await rowCount()).toBe(0);
  });

  it("isolates tenants: seeding one tenant leaves another's brain rows untouched", async () => {
    await activateBrainRoles();
    await seedBrains({ service, store }, owner);

    const rows = (await handle.db.execute(
      sql`select count(*)::int as n from workforce_agents where tenant_id <> ${owner.tenantId}`,
    )) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });
});
