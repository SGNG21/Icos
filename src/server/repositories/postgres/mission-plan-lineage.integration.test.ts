import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { autonomousPlans, missionTasks, missions } from "@/server/database/schema";
import { fingerprintMissionPlan, type MissionPlan } from "@/server/mission/mission-plan";

const DATABASE_URL = TEST_DATABASE_URL;

/*
 * Durable proof of immutable autonomous plan lineage (mission N8/N9/N10).
 *
 * In-memory tests cannot prove durability, uniqueness constraints or foreign
 * keys. These run against real PostgreSQL.
 */

const planA: MissionPlan = {
  version: 1,
  tasks: [
    { key: "a", title: "Lineage A", description: "A", dependsOn: [] },
    { key: "b", title: "Lineage B", description: "B", dependsOn: ["a"] },
  ],
};

const planB: MissionPlan = {
  version: 1,
  tasks: [
    { key: "a", title: "Lineage A", description: "A", dependsOn: [] },
    { key: "b", title: "Lineage B", description: "B", dependsOn: ["a"] },
    { key: "c", title: "Lineage C", description: "C", dependsOn: [] },
  ],
};

const planC: MissionPlan = {
  version: 1,
  tasks: [{ key: "solo", title: "Lineage solo", description: "S", dependsOn: [] }],
};

describe("PostgreSQL immutable autonomous plan lineage", () => {
  let container: Container;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "core3-lineage-test-key",
      ICOS_REVIEWER_MODEL: "core3-lineage-reviewer",
    });
    container = await buildPostgresContainer(DATABASE_URL, undefined, env);
  });

  afterAll(async () => {
    if (container?.db) {
      await container.db.execute(
        sql`TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE`,
      );
    }
    await container?.close();
  });

  beforeEach(async () => {
    if (!container.db) throw new Error("PostgreSQL handle missing");
    await container.db.execute(
      sql`TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE`,
    );
  });

  const db = () => {
    if (!container.db) throw new Error("PostgreSQL handle missing");
    return container.db;
  };

  const lineage = (missionId: string) =>
    container.mission.listPlanLineage!(missionId);

  const goalMission = async () => {
    const goalId = `goal-${randomUUID()}`;
    const mission = await container.mission.create({
      title: "Lineage mission",
      objective: "Prove durable plan lineage",
      goalId,
      tasks: [],
    });
    return { mission, goalId };
  };

  it("persists P1 at version 1 with no predecessor, and planId is not the fingerprint", async () => {
    const { mission, goalId } = await goalMission();

    await container.mission.applyPlan(mission.id, planA);

    const rows = await lineage(mission.id);
    expect(rows).toHaveLength(1);

    const p1 = rows[0];
    expect(p1.version).toBe(1);
    expect(p1.predecessorPlanId).toBeNull();
    expect(p1.goalId).toBe(goalId);
    expect(p1.planFingerprint).toBe(fingerprintMissionPlan(planA));

    // Identity is never the content digest.
    expect(p1.planId).not.toBe(p1.planFingerprint);
    expect(p1.planId).not.toBe(mission.id);
    expect(p1.planId).not.toBe(goalId);

    // The mission current-plan pointer is durable.
    const stored = await db()
      .select({ planId: missions.planId, goalId: missions.goalId })
      .from(missions)
      .where(eq(missions.id, mission.id));
    expect(stored[0].planId).toBe(p1.planId);
    expect(stored[0].goalId).toBe(goalId);
  });

  it("reuses P1 on an applyPlan retry of the same logical plan (crash-window idempotency)", async () => {
    const { mission } = await goalMission();

    await container.mission.applyPlan(mission.id, planA);
    const [p1] = await lineage(mission.id);

    /*
     * Simulate a crash between persisting the plan row and materializing the
     * MissionTasks: the plan row survives, the tasks do not. The retry must
     * reuse the SAME persisted plan version rather than allocate P2.
     */
    await db()
      .delete(missionTasks)
      .where(eq(missionTasks.missionId, mission.id));

    await container.mission.applyPlan(mission.id, planA);

    const rows = await lineage(mission.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].planId).toBe(p1.planId);
    expect(rows[0].version).toBe(1);
  });

  it("appends P2 with a new identity linked to P1, leaving P1 byte-identical", async () => {
    const { mission } = await goalMission();

    await container.mission.applyPlan(mission.id, planA);
    const [p1Before] = await lineage(mission.id);

    await container.mission.replacePlan!(mission.id, planB);

    const rows = await lineage(mission.id);
    expect(rows).toHaveLength(2);

    const [p1, p2] = rows;

    // P1 is immutable history — not one field changed.
    expect(p1).toEqual(p1Before);

    expect(p2.version).toBe(2);
    expect(p2.planId).not.toBe(p1.planId);
    expect(p2.predecessorPlanId).toBe(p1.planId);
    expect(p2.planFingerprint).toBe(fingerprintMissionPlan(planB));

    // predecessor references the logical plan identity, not the surrogate id.
    expect(p2.predecessorPlanId).not.toBe(p1.id);

    const stored = await db()
      .select({ planId: missions.planId })
      .from(missions)
      .where(eq(missions.id, mission.id));
    expect(stored[0].planId).toBe(p2.planId);
  });

  it("builds a durable P1 <- P2 <- P3 chain", async () => {
    const { mission } = await goalMission();

    await container.mission.applyPlan(mission.id, planA);
    await container.mission.replacePlan!(mission.id, planB);
    await container.mission.replacePlan!(mission.id, planC);

    const rows = await lineage(mission.id);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);

    const [p1, p2, p3] = rows;
    expect(p1.predecessorPlanId).toBeNull();
    expect(p2.predecessorPlanId).toBe(p1.planId);
    expect(p3.predecessorPlanId).toBe(p2.planId);
    expect(new Set(rows.map((r) => r.planId)).size).toBe(3);

    // Superseded versions remain queryable.
    const p1Again = await db()
      .select()
      .from(autonomousPlans)
      .where(eq(autonomousPlans.planId, p1.planId));
    expect(p1Again).toHaveLength(1);
    expect(p1Again[0].version).toBe(1);
  });

  it("enforces UNIQUE(mission_id, version) durably", async () => {
    const { mission, goalId } = await goalMission();
    await container.mission.applyPlan(mission.id, planA);

    await expect(
      db()
        .insert(autonomousPlans)
        .values({
          id: randomUUID(),
          missionId: mission.id,
          goalId,
          planId: randomUUID(),
          planFingerprint: `duplicate-version-${randomUUID()}`,
          version: 1, // already taken by P1
          predecessorPlanId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
    ).rejects.toThrow();
  });

  it("enforces UNIQUE(plan_id) durably", async () => {
    const { mission, goalId } = await goalMission();
    await container.mission.applyPlan(mission.id, planA);
    const [p1] = await lineage(mission.id);

    await expect(
      db()
        .insert(autonomousPlans)
        .values({
          id: randomUUID(),
          missionId: mission.id,
          goalId,
          planId: p1.planId, // identity collision
          planFingerprint: `other-${randomUUID()}`,
          version: 99,
          predecessorPlanId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
    ).rejects.toThrow();
  });

  it("rejects a predecessor that references no existing plan identity", async () => {
    const { mission, goalId } = await goalMission();
    await container.mission.applyPlan(mission.id, planA);

    await expect(
      db()
        .insert(autonomousPlans)
        .values({
          id: randomUUID(),
          missionId: mission.id,
          goalId,
          planId: randomUUID(),
          planFingerprint: `dangling-${randomUUID()}`,
          version: 2,
          predecessorPlanId: randomUUID(), // no such plan_id
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
    ).rejects.toThrow();
  });

  it("keeps a generic mission (no goalId) free of plan lineage", async () => {
    const mission = await container.mission.create({
      title: "Generic mission",
      objective: "No goal, no lineage",
      tasks: [],
    });

    const applied = await container.mission.applyPlan(mission.id, planA);
    expect(applied).toHaveLength(2);

    // Lineage is skipped, never faked.
    expect(await lineage(mission.id)).toHaveLength(0);

    const stored = await db()
      .select({ planId: missions.planId, goalId: missions.goalId })
      .from(missions)
      .where(eq(missions.id, mission.id));
    expect(stored[0].goalId).toBeNull();
    expect(stored[0].planId).toBeNull();
  });

  it("scopes fingerprint idempotency to the mission", async () => {
    const first = await goalMission();
    const second = await goalMission();

    await container.mission.applyPlan(first.mission.id, planA);
    await container.mission.applyPlan(second.mission.id, planA);

    const [p1] = await lineage(first.mission.id);
    const [p2] = await lineage(second.mission.id);

    // Same logical plan, two missions: same fingerprint, DIFFERENT identities.
    expect(p1.planFingerprint).toBe(p2.planFingerprint);
    expect(p1.planId).not.toBe(p2.planId);

    const sameFingerprint = await db()
      .select()
      .from(autonomousPlans)
      .where(
        and(
          eq(autonomousPlans.missionId, first.mission.id),
          eq(autonomousPlans.planFingerprint, p1.planFingerprint),
        ),
      );
    expect(sameFingerprint).toHaveLength(1);
  });
});
