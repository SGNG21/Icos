import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { tasks as tasksTable } from "@/server/database/schema";
import { computeReadyTasks } from "@/server/supervisor/readiness";
import type { MissionPlan } from "@/server/mission/mission-plan";

const DATABASE_URL = TEST_DATABASE_URL;

/*
 * M3 — durable proof that readiness derives from ONE canonical authority
 * (decision 0030), against real PostgreSQL and across a real restart.
 */

const opened = new Set<Container>();

async function freshProcess(): Promise<Container> {
  const env = loadEnv({
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
    OMNIROUTE_API_KEY: "core3-m3-test-key",
    ICOS_REVIEWER_MODEL: "core3-m3-reviewer",
  });
  const container = await buildPostgresContainer(
    DATABASE_URL,
    undefined,
    env,
  );
  opened.add(container);
  return container;
}

/** A ─┐
 *     ├─> C
 *  B ─┘
 */
const fanInPlan: MissionPlan = {
  version: 1,
  tasks: [
    { key: "a", title: "Branch A", dependsOn: [] },
    { key: "b", title: "Branch B", dependsOn: [] },
    {
      key: "c",
      title: "Join C",
      dependsOn: ["a", "b"],
    },
  ],
};

describe("PostgreSQL canonical readiness authority", () => {
  afterEach(async () => {
    for (const container of [...opened]) {
      opened.delete(container);
      await container.close();
    }
  });

  const seed = async (container: Container) => {
    if (!container.db) {
      throw new Error("PostgreSQL handle missing");
    }
    await container.db.execute(
      sql`TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE`,
    );
    const mission = await container.mission.create({
      title: "M3 readiness mission",
      objective: "Prove canonical dependency gating",
      goalId: `goal-${randomUUID()}`,
      tasks: [],
    });
    await container.mission.applyPlan(
      mission.id,
      fanInPlan,
    );
    return mission;
  };

  /** Readiness computed strictly from persisted state. */
  const readyFromDb = async (
    container: Container,
    missionId: string,
  ) => {
    const mission = await container.mission.findById(
      missionId,
    );
    const missionTasks =
      await container.mission.listTasks(missionId);
    return computeReadyTasks(
      mission!,
      missionTasks,
    ).map((t) => t.title);
  };

  const idOf = async (
    container: Container,
    missionId: string,
    title: string,
  ) => {
    const all = await container.mission.listTasks(
      missionId,
    );
    return all.find((t) => t.title === title)!;
  };

  it("gates the join on BOTH canonical dependencies, and keeps roots parallel", async () => {
    const container = await freshProcess();
    const mission = await seed(container);

    // Both roots runnable at once; the join is blocked.
    expect(
      (
        await readyFromDb(container, mission.id)
      ).sort(),
    ).toEqual(["Branch A", "Branch B"]);

    const a = await idOf(
      container,
      mission.id,
      "Branch A",
    );
    const b = await idOf(
      container,
      mission.id,
      "Branch B",
    );

    await container.mission.updateMissionTaskStatus(
      mission.id,
      a.id,
      "succeeded",
    );

    // One dependency complete is not enough.
    expect(
      await readyFromDb(container, mission.id),
    ).toEqual(["Branch B"]);

    await container.mission.updateMissionTaskStatus(
      mission.id,
      b.id,
      "succeeded",
    );

    // Now, and only now, the join unlocks.
    expect(
      await readyFromDb(container, mission.id),
    ).toEqual(["Join C"]);
  });

  it("does not unlock downstream while a dependency is merely running (stale worker claim)", async () => {
    const container = await freshProcess();
    const mission = await seed(container);

    const a = await idOf(
      container,
      mission.id,
      "Branch A",
    );
    const b = await idOf(
      container,
      mission.id,
      "Branch B",
    );

    // A worker took both branches but neither is canonically complete.
    await container.mission.updateMissionTaskStatus(
      mission.id,
      a.id,
      "running",
    );
    await container.mission.updateMissionTaskStatus(
      mission.id,
      b.id,
      "running",
    );

    expect(
      await readyFromDb(container, mission.id),
    ).toEqual([]);
  });

  it("preserves readiness exactly across a process restart", async () => {
    const first = await freshProcess();
    const mission = await seed(first);

    const a = await idOf(first, mission.id, "Branch A");
    await first.mission.updateMissionTaskStatus(
      mission.id,
      a.id,
      "succeeded",
    );

    const before = await readyFromDb(
      first,
      mission.id,
    );
    expect(before).toEqual(["Branch B"]);

    // Full restart: nothing survives in memory.
    opened.delete(first);
    await first.close();

    const restarted = await freshProcess();
    const after = await readyFromDb(
      restarted,
      mission.id,
    );

    expect(after).toEqual(before);

    // Completing the last dependency after restart unlocks the join.
    const b = await idOf(
      restarted,
      mission.id,
      "Branch B",
    );
    await restarted.mission.updateMissionTaskStatus(
      mission.id,
      b.id,
      "succeeded",
    );
    expect(
      await readyFromDb(restarted, mission.id),
    ).toEqual(["Join C"]);
  });

  it("is idempotent: recomputing readiness never advances anything twice", async () => {
    const container = await freshProcess();
    const mission = await seed(container);

    const first = await readyFromDb(
      container,
      mission.id,
    );
    const second = await readyFromDb(
      container,
      mission.id,
    );
    const third = await readyFromDb(
      container,
      mission.id,
    );

    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // A dispatched task stops being offered, so a re-run cannot double-dispatch.
    const a = await idOf(
      container,
      mission.id,
      "Branch A",
    );
    await container.mission.updateMissionTaskStatus(
      mission.id,
      a.id,
      "queued",
    );
    expect(
      await readyFromDb(container, mission.id),
    ).toEqual(["Branch B"]);
  });

  it("ignores contradictory tasks.dependencies written directly to the database", async () => {
    const container = await freshProcess();
    const mission = await seed(container);

    const a = await idOf(
      container,
      mission.id,
      "Branch A",
    );

    /*
     * decision 0030: tasks.dependencies is NON-authoritative. Write a bogus
     * blocking edge straight onto the canonical Task row — the shape an API
     * caller could produce — and prove readiness is unaffected.
     */
    await container.db!
      .update(tasksTable)
      .set({
        dependencies: [
          {
            taskId: "totally-unrelated",
            type: "blocking",
          },
        ],
      })
      .where(eq(tasksTable.id, a.taskId));

    // Root A is still runnable: advisory data cannot block it.
    expect(
      (
        await readyFromDb(container, mission.id)
      ).sort(),
    ).toEqual(["Branch A", "Branch B"]);

    // And it is genuinely persisted, so the read path really did see it.
    const stored = await container.tasks.getById(
      a.taskId,
    );
    expect(stored?.dependencies).toEqual([
      { taskId: "totally-unrelated", type: "blocking" },
    ]);
  });

  it("leaves tasks.dependencies empty on the autonomous plan path", async () => {
    const container = await freshProcess();
    const mission = await seed(container);

    const all = await container.mission.listTasks(
      mission.id,
    );

    for (const missionTask of all) {
      const canonical =
        await container.tasks.getById(
          missionTask.taskId,
        );
      expect(canonical?.dependencies).toEqual([]);
      // The real edges live on the MissionTask.
      expect(
        Array.isArray(missionTask.dependsOn),
      ).toBe(true);
    }

    const join = all.find(
      (t) => t.title === "Join C",
    )!;
    expect(join.dependsOn).toHaveLength(2);
  });

  it("returns a stable task order across repeated reads and status churn", async () => {
    /*
     * Deterministic order is REQUIRED here, not cosmetic: computeReadyTasks
     * preserves input order and the supervisor dispatches ready tasks in that
     * order. listTasks() had no ORDER BY, so PostgreSQL row order was
     * unspecified — and it genuinely shifts as rows are UPDATEd during a
     * mission, which is exactly what happens to task statuses mid-run.
     */
    const container = await freshProcess();
    const mission = await seed(container);

    const readOrder = async () =>
      (
        await container.mission.listTasks(mission.id)
      ).map((t) => t.id);

    const baseline = await readOrder();
    expect(await readOrder()).toEqual(baseline);
    expect(await readOrder()).toEqual(baseline);

    // Churn the rows the way a running mission does.
    const a = await idOf(
      container,
      mission.id,
      "Branch A",
    );
    const b = await idOf(
      container,
      mission.id,
      "Branch B",
    );
    await container.mission.updateMissionTaskStatus(
      mission.id,
      a.id,
      "queued",
    );
    await container.mission.updateMissionTaskStatus(
      mission.id,
      b.id,
      "running",
    );
    await container.mission.updateMissionTaskStatus(
      mission.id,
      a.id,
      "succeeded",
    );

    expect(await readOrder()).toEqual(baseline);

    // And the order is the same after a full restart.
    opened.delete(container);
    await container.close();

    const restarted = await freshProcess();
    expect(
      (
        await restarted.mission.listTasks(mission.id)
      ).map((t) => t.id),
    ).toEqual(baseline);
  });

  it("does not let a replan unlock superseded nodes", async () => {
    const container = await freshProcess();
    const mission = await seed(container);

    const a = await idOf(
      container,
      mission.id,
      "Branch A",
    );
    await container.mission.updateMissionTaskStatus(
      mission.id,
      a.id,
      "succeeded",
    );

    // Replace the unfinished graph.
    await container.mission.replacePlan!(mission.id, {
      version: 1,
      tasks: [
        {
          key: "fresh",
          title: "Fresh work",
          dependsOn: [],
        },
      ],
    });

    const after = await container.mission.listTasks(
      mission.id,
    );

    // B and C were replaced, not deleted (decision 0029).
    const superseded = after.filter(
      (t) => t.status === "superseded",
    );
    expect(
      superseded.map((t) => t.title).sort(),
    ).toEqual(["Branch B", "Join C"]);

    // Only the replacement is runnable: no superseded node is resurrected, and
    // the abandoned join is not unlocked by its superseded dependency.
    expect(
      await readyFromDb(container, mission.id),
    ).toEqual(["Fresh work"]);
  });
});
