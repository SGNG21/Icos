import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { describeScheduledJobRepositoryContract } from "@/server/scheduler/scheduler-job-repository.contract";

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = createDatabase(TEST_DATABASE_URL, { max: 12 });
  await handle.db.execute(sql`select 1`);
});

afterAll(async () => {
  await handle.db.execute(sql.raw("TRUNCATE TABLE scheduled_jobs"));
  await handle.close();
});

const fresh = async () => {
  await handle.db.execute(sql.raw("TRUNCATE TABLE scheduled_jobs"));
  return new PostgresScheduledJobRepository(handle.db);
};

/**
 * Make `ms` of DATABASE time pass for the scheduler: every stored instant the
 * repository compares with `now()` moves `ms` into the past. Equivalent to the
 * database clock advancing, without sleeping against a wall-clock lease.
 */
const elapse = async (ms: number) => {
  await handle.db.execute(sql`
    UPDATE scheduled_jobs
       SET lease_until = lease_until - (${ms} * interval '1 millisecond'),
           next_run_at = next_run_at - (${ms} * interval '1 millisecond'),
           deadline_at = deadline_at - (${ms} * interval '1 millisecond')`);
};

describeScheduledJobRepositoryContract("PostgreSQL", fresh, elapse);

describe("PostgreSQL scheduled jobs — durability across process restarts", () => {
  const base = {
    kind: "start_mission" as const,
    payload: { title: "t", objective: "o" },
    payloadHash: "h",
    idempotencyKey: "restart-k",
    runAt: new Date(Date.now() - 1_000),
  };

  it("a new repository/connection resumes a job claimed by a crashed process", async () => {
    await handle.db.execute(sql.raw("TRUNCATE TABLE scheduled_jobs"));
    const first = new PostgresScheduledJobRepository(handle.db);
    const { job } = await first.enqueue(base);
    await first.claimDue("crashed-process", 60_000);

    // "Restart": brand new connection pool and repository, same database.
    const other = createDatabase(TEST_DATABASE_URL, { max: 2 });
    try {
      const second = new PostgresScheduledJobRepository(other.db);
      expect(await second.claimDue("restarted", 1_000)).toBeNull(); // lease not expired yet
      await elapse(61_000); // the crashed owner never renews: its lease runs out
      const reclaimed = await second.claimDue("restarted", 60_000);
      expect(reclaimed).toMatchObject({ id: job.id, attemptCount: 2, leaseOwner: "restarted" });
      expect(await second.complete(job.id, "restarted")).toBe(true);
    } finally {
      await other.close();
    }
  });

  it("uses the database clock: 20 concurrent claimers on 5 due jobs yield 5 distinct claims", async () => {
    await handle.db.execute(sql.raw("TRUNCATE TABLE scheduled_jobs"));
    const repos = Array.from({ length: 20 }, () => new PostgresScheduledJobRepository(handle.db));
    for (let i = 0; i < 5; i++) {
      await repos[0].enqueue({ ...base, idempotencyKey: `c-${i}`, payloadHash: `h-${i}` });
    }
    const results = await Promise.all(repos.map((r, i) => r.claimDue(`w-${i}`, 60_000)));
    const ids = results.filter((j) => j !== null).map((j) => j!.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
});
