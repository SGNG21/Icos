import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";

let handle: DatabaseHandle;
let missions: PostgresMissionRepository;

beforeAll(async () => {
  handle = createDatabase(TEST_DATABASE_URL, { max: 8 });
  await handle.db.execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));
  missions = new PostgresMissionRepository(handle.db, new PostgresTaskRepository(handle.db));
});

afterAll(async () => {
  await handle.db.execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));
  await handle.close();
});

describe("PostgreSQL MissionRepository.create with an imposed id", () => {
  it("is idempotent: replays and concurrent creates converge on one mission", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        missions.create({ id: "mission-idem", title: "T", objective: "O", tasks: [] }),
      ),
    );
    expect(new Set(results.map((m) => m.id))).toEqual(new Set(["mission-idem"]));
    expect(await missions.list()).toHaveLength(1);
    expect((await missions.findById("mission-idem"))?.status).toBe("draft");
  });

  it("refuses an id reused for a different mission, and non-empty graphs", async () => {
    await missions.create({ id: "mission-x", title: "T", objective: "O", tasks: [] });
    await expect(
      missions.create({ id: "mission-x", title: "Other", objective: "O", tasks: [] }),
    ).rejects.toThrow("MISSION_ID_CONFLICT");
    await expect(
      missions.create({
        id: "mission-y",
        title: "T",
        objective: "O",
        tasks: [{ title: "a", description: "a", dependsOn: [], workerKind: "agent", capability: null }],
      }),
    ).rejects.toThrow("MISSION_CREATE_ID_REQUIRES_EMPTY_GRAPH");
  });
});
