import {
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import {
  fingerprintMissionPlan,
  type MissionPlan,
} from "@/server/mission/mission-plan";

/*
 * Immutable autonomous plan lineage (mission N8/N10).
 *
 * Proven here:
 *   planId != planFingerprint
 *   first plan  -> version 1, predecessorPlanId null
 *   replan      -> NEW planId, version + 1, predecessorPlanId = previous planId
 *   P1 remains immutable and queryable after P2 and P3
 *   mission current-plan pointer only advances
 *   applyPlan may only initialize an empty mission (parity with Postgres)
 */

const planA: MissionPlan = {
  version: 1,
  tasks: [
    {
      key: "a",
      title: "Task A",
      description: "Do A",
      dependsOn: [],
    },
    {
      key: "b",
      title: "Task B",
      description: "Do B",
      dependsOn: ["a"],
    },
  ],
};

const planB: MissionPlan = {
  version: 1,
  tasks: [
    {
      key: "a",
      title: "Task A",
      description: "Do A",
      dependsOn: [],
    },
    {
      key: "b",
      title: "Task B",
      description: "Do B",
      dependsOn: ["a"],
    },
    {
      key: "c",
      title: "Task C",
      description: "Do C",
      dependsOn: [],
    },
  ],
};

const planC: MissionPlan = {
  version: 1,
  tasks: [
    {
      key: "solo",
      title: "Single replacement task",
      description: "Do it differently",
      dependsOn: [],
    },
  ],
};

describe("InMemoryMissionRepository — immutable plan lineage", () => {
  let missions: InMemoryMissionRepository;
  let tasks: InMemoryTaskRepository;

  beforeEach(() => {
    tasks = new InMemoryTaskRepository(
      new InMemoryAuditLog(),
      [],
    );
    missions = new InMemoryMissionRepository(
      tasks,
    );
  });

  const newMission = async (): Promise<string> => {
    const missionId = randomUUID();
    await missions.create({
      id: missionId,
      title: "Mission",
      objective: "Obj",
      goalId: randomUUID(),
      tasks: [],
    });
    return missionId;
  };

  it("first applyPlan persists P1 at version 1 with no predecessor", async () => {
    const missionId = await newMission();

    const created = await missions.applyPlan(
      missionId,
      planA,
    );
    expect(created).toHaveLength(2);

    const lineage =
      await missions.listPlanLineage(missionId);
    expect(lineage).toHaveLength(1);

    const p1 = lineage[0];
    expect(p1.version).toBe(1);
    expect(p1.predecessorPlanId ?? null).toBeNull();
    expect(p1.missionId).toBe(missionId);

    const mission =
      await missions.findById(missionId);
    expect(mission?.planId).toBe(p1.planId);
  });

  it("never uses the fingerprint as the plan identity", async () => {
    const missionId = await newMission();
    await missions.applyPlan(missionId, planA);

    const [p1] =
      await missions.listPlanLineage(missionId);

    expect(p1.planFingerprint).toBe(
      fingerprintMissionPlan(planA),
    );
    expect(p1.planId).not.toBe(
      p1.planFingerprint,
    );
    // planId is an allocated identity, not a digest.
    expect(p1.planId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("refuses a second applyPlan on an already-planned mission (parity with Postgres)", async () => {
    const missionId = await newMission();
    await missions.applyPlan(missionId, planA);

    await expect(
      missions.applyPlan(missionId, planA),
    ).rejects.toThrow(
      `MISSION_PLAN_ALREADY_APPLIED:${missionId}`,
    );

    // The rejected retry must not have appended a lineage row.
    expect(
      await missions.listPlanLineage(missionId),
    ).toHaveLength(1);
  });

  it("replacePlan appends P2 with a new identity linked to P1", async () => {
    const missionId = await newMission();
    await missions.applyPlan(missionId, planA);

    const [p1Before] =
      await missions.listPlanLineage(missionId);
    const p1Snapshot = { ...p1Before };

    await missions.replacePlan(missionId, planB);

    const lineage =
      await missions.listPlanLineage(missionId);
    expect(lineage).toHaveLength(2);

    const [p1, p2] = lineage;

    // P1 is immutable history.
    expect(p1).toEqual(p1Snapshot);

    expect(p2.version).toBe(2);
    expect(p2.planId).not.toBe(p1.planId);
    expect(p2.predecessorPlanId).toBe(p1.planId);
    expect(p2.planFingerprint).toBe(
      fingerprintMissionPlan(planB),
    );
    expect(p2.planFingerprint).not.toBe(
      p1.planFingerprint,
    );

    // The mission pointer advances to the new version.
    const mission =
      await missions.findById(missionId);
    expect(mission?.planId).toBe(p2.planId);
  });

  it("builds a P1 <- P2 <- P3 chain across two replans", async () => {
    const missionId = await newMission();
    await missions.applyPlan(missionId, planA);
    await missions.replacePlan(missionId, planB);
    await missions.replacePlan(missionId, planC);

    const lineage =
      await missions.listPlanLineage(missionId);
    expect(lineage).toHaveLength(3);

    const [p1, p2, p3] = lineage;

    expect(
      lineage.map((p) => p.version),
    ).toEqual([1, 2, 3]);

    expect(p1.predecessorPlanId ?? null).toBeNull();
    expect(p2.predecessorPlanId).toBe(p1.planId);
    expect(p3.predecessorPlanId).toBe(p2.planId);

    // Every version has a distinct identity.
    expect(
      new Set([p1.planId, p2.planId, p3.planId])
        .size,
    ).toBe(3);

    // predecessorPlanId references planId, never the surrogate id.
    expect(p2.predecessorPlanId).not.toBe(p1.id);
    expect(p3.predecessorPlanId).not.toBe(p2.id);

    const mission =
      await missions.findById(missionId);
    expect(mission?.planId).toBe(p3.planId);
  });

  it("keeps superseded versions queryable after replanning", async () => {
    const missionId = await newMission();
    await missions.applyPlan(missionId, planA);

    const [p1] =
      await missions.listPlanLineage(missionId);
    const originalPlanId = p1.planId;
    const originalFingerprint =
      p1.planFingerprint;

    await missions.replacePlan(missionId, planB);
    await missions.replacePlan(missionId, planC);

    const lineage =
      await missions.listPlanLineage(missionId);
    const recovered = lineage.find(
      (p) => p.planId === originalPlanId,
    );

    expect(recovered).toBeDefined();
    expect(recovered?.version).toBe(1);
    expect(recovered?.planFingerprint).toBe(
      originalFingerprint,
    );
  });

  it("allocates a distinct version per replan even for identical plan content", async () => {
    const missionId = await newMission();
    await missions.applyPlan(missionId, planA);
    await missions.replacePlan(missionId, planB);
    await missions.replacePlan(missionId, planB);

    const lineage =
      await missions.listPlanLineage(missionId);

    // Versions are unique and monotonic; a replan is never an in-place edit.
    expect(
      lineage.map((p) => p.version),
    ).toEqual([1, 2, 3]);
    expect(
      new Set(lineage.map((p) => p.planId)).size,
    ).toBe(3);
  });
});
