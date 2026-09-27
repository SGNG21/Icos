import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";

const DATABASE_URL = TEST_DATABASE_URL;

describe("PostgreSQL mission graph replacement", () => {
  let container: Container;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "phase-5-graph-test-key",
      ICOS_REVIEWER_MODEL: "phase-5-graph-reviewer",
    });
    container = await buildPostgresContainer(DATABASE_URL, undefined, env);
  });

  afterAll(async () => {
    if (container?.db) {
      await container.db.execute(sql`TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE`);
    }
    await container?.close();
  });

  it("preserves succeeded history and replaces failed/draft work atomically", async () => {
    if (!container.db) throw new Error("PostgreSQL handle missing");
    await container.db.execute(sql`TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE`);
    const mission = await container.mission.create({
      title: "Replan mission",
      objective: "Replace only unfinished work",
      tasks: [
        { title: "Completed history", dependsOn: [], workerKind: "hermes", capability: null },
        { title: "Failed branch", dependsOn: [], workerKind: "hermes", capability: null },
      ],
    });
    const before = await container.mission.listTasks(mission.id);
    await container.mission.updateMissionTaskStatus(mission.id, before[0].id, "succeeded");
    await container.mission.updateMissionTaskStatus(mission.id, before[1].id, "failed");

    const after = await container.mission.replacePlan!(mission.id, {
      version: 1,
      tasks: [
        { key: "fix", title: "Replacement branch", dependsOn: [], workerKind: "hermes" },
      ],
    });

    /*
     * Decision 0029: a replan preserves history instead of deleting rows.
     * Succeeded work is kept untouched, unfinished work becomes `superseded`,
     * and the new plan's tasks are created as `draft`.
     */
    expect(after).toHaveLength(3);
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: before[0].id, status: "succeeded" }),
        expect.objectContaining({ id: before[1].id, status: "superseded" }),
        expect.objectContaining({ title: "Replacement branch", status: "draft" }),
      ]),
    );

    // The failed branch is retained as durable history, never deleted.
    const supersededTask = after.find((task) => task.id === before[1].id);
    expect(supersededTask).toBeDefined();
    expect(supersededTask?.status).toBe("superseded");

    // And it is durably persisted, not merely reported.
    const persisted = await container.mission.listTasks(mission.id);
    expect(persisted).toHaveLength(3);
    expect(
      persisted.find((task) => task.id === before[1].id)?.status,
    ).toBe("superseded");
    expect(
      persisted.find((task) => task.id === before[0].id)?.status,
    ).toBe("succeeded");
  });

  it("rolls back the whole replacement when an insert fails", async () => {
    if (!container.db) throw new Error("PostgreSQL handle missing");
    await container.db.execute(sql`TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE`);
    const mission = await container.mission.create({
      title: "Atomic replan mission",
      objective: "No partial graph mutation",
      tasks: [
        { title: "Existing failed branch", dependsOn: [], workerKind: "hermes", capability: null },
      ],
    });
    const before = await container.mission.listTasks(mission.id);
    await container.mission.updateMissionTaskStatus(mission.id, before[0].id, "failed");
    await container.db.execute(sql`
      CREATE OR REPLACE FUNCTION phase5_fail_replan_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = 'INJECT REPLAN FAILURE' THEN
          RAISE EXCEPTION 'phase5 injected replacement failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await container.db.execute(sql`
      CREATE TRIGGER phase5_replan_failure
      BEFORE INSERT ON mission_tasks
      FOR EACH ROW EXECUTE FUNCTION phase5_fail_replan_insert()
    `);

    try {
      await expect(
        container.mission.replacePlan!(mission.id, {
          version: 1,
          tasks: [{ key: "fail", title: "INJECT REPLAN FAILURE", dependsOn: [] }],
        }),
      ).rejects.toThrow();
      expect(await container.mission.listTasks(mission.id)).toEqual([
        expect.objectContaining({ id: before[0].id, status: "failed" }),
      ]);
    } finally {
      await container.db.execute(sql`DROP TRIGGER IF EXISTS phase5_replan_failure ON mission_tasks`);
      await container.db.execute(sql`DROP FUNCTION IF EXISTS phase5_fail_replan_insert()`);
    }
  });
});
