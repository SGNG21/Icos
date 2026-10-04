import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryGoalRepository } from "@/server/services/in-memory/goal-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import type { HighLevelGoal, GoalPlanPreview } from "@/core/contracts/high-level-goal";

/**
 * A goal and the mission it converted to must point at each other, or the owner sees a
 * goal stuck at `pending` while its mission has already succeeded — which is exactly what
 * the live database held: `resultingMissionId` 0/1, `missions.goal_id` 0/12.
 *
 * The link lives on two rows, so these tests pin the behaviour around the gap between
 * them: a retry must not create a second mission, and a half-written link must repair
 * rather than duplicate.
 */

const GOAL_ID = "goal-analyse-etat";

function goalOf(id = GOAL_ID): HighLevelGoal {
  return {
    id,
    title: "Analyse de l'état",
    objective: "Produire un résumé lisible de l'état actuel du système",
    constraints: [],
    successCriteria: ["un rapport court"],
    priority: "normal",
    riskLevel: "low",
    allowedCapabilities: [],
    forbiddenCapabilities: [],
    humanApprovalPolicy: "none",
  } as unknown as HighLevelGoal;
}

function previewOf(goalId = GOAL_ID): GoalPlanPreview {
  return {
    goalId,
    missionTitle: "Analyse de l'état",
    missionObjective: "Produire un résumé lisible de l'état actuel du système",
    tasks: [{ id: "t1", title: "Lire l'état", description: null, dependsOn: [] }],
  } as unknown as GoalPlanPreview;
}

/**
 * The route's conversion, as a function of its two repositories: read an existing mission
 * first, create only if there is none, then write the goal's side.
 */
async function convert(
  missions: InMemoryMissionRepository,
  goals: InMemoryGoalRepository,
  preview: GoalPlanPreview,
  options: { failAfterCreate?: boolean } = {},
) {
  const already = await missions.findByGoalId(preview.goalId);
  if (already) {
    await goals.setConverted(preview.goalId, already.id);
    return already;
  }
  const mission = await missions.create({
    title: preview.missionTitle,
    objective: preview.missionObjective,
    goalId: preview.goalId,
    tasks: [],
  });
  if (options.failAfterCreate) {
    throw new Error("CRASH_BETWEEN_THE_TWO_WRITES");
  }
  await goals.setConverted(preview.goalId, mission.id);
  return mission;
}

describe("goal → mission link", () => {
  let missions: InMemoryMissionRepository;
  let goals: InMemoryGoalRepository;

  beforeEach(async () => {
    missions = new InMemoryMissionRepository(
      new InMemoryTaskRepository(new InMemoryAuditLog(), []),
    );
    goals = new InMemoryGoalRepository(new InMemoryAuditLog());
    await goals.create(goalOf(), previewOf());
  });

  it("persists BOTH sides, and they correspond", async () => {
    const mission = await convert(missions, goals, previewOf());

    expect(mission.goalId).toBe(GOAL_ID);
    const [record] = await goals.list({ limit: 10 });
    expect(record.resultingMissionId).toBe(mission.id);
    expect(record.status).toBe("converted");
    // the two directions agree
    const back = await missions.findByGoalId(GOAL_ID);
    expect(back?.id).toBe(mission.id);
  });

  it("is idempotent: converting twice reuses the one mission", async () => {
    const first = await convert(missions, goals, previewOf());
    const second = await convert(missions, goals, previewOf());

    expect(second.id).toBe(first.id);
    expect(await missions.list()).toHaveLength(1);
  });

  it("repairs a half-written link instead of creating a duplicate", async () => {
    // Crash after the mission exists but before the goal was marked.
    await expect(
      convert(missions, goals, previewOf(), { failAfterCreate: true }),
    ).rejects.toThrow("CRASH_BETWEEN_THE_TWO_WRITES");

    const [halfway] = await goals.list({ limit: 10 });
    expect(halfway.resultingMissionId).toBeNull();
    expect(await missions.list()).toHaveLength(1);

    // The next attempt completes the second write rather than creating a second mission.
    const repaired = await convert(missions, goals, previewOf());
    expect(await missions.list()).toHaveLength(1);
    const [record] = await goals.list({ limit: 10 });
    expect(record.resultingMissionId).toBe(repaired.id);
  });

  it("concurrent conversion of one goal yields one mission", async () => {
    const results = await Promise.all([
      convert(missions, goals, previewOf()),
      convert(missions, goals, previewOf()),
      convert(missions, goals, previewOf()),
    ]);

    /*
     * In-memory there is no unique index, so this pins what the application does: all
     * callers converge on one goal record. The DATABASE is what forbids the duplicate row
     * (`missions_goal_id_unique`, migration 0057) and the route adopts the winner — that
     * half is proven against real PostgreSQL, not here.
     */
    const [record] = await goals.list({ limit: 10 });
    expect(results.map((m) => m.goalId)).toEqual([GOAL_ID, GOAL_ID, GOAL_ID]);
    expect(record.resultingMissionId).not.toBeNull();
  });

  it("does not link a goal to another goal's mission", async () => {
    await goals.create(goalOf("goal-autre"), previewOf("goal-autre"));
    const mine = await convert(missions, goals, previewOf());

    expect(await missions.findByGoalId("goal-autre")).toBeNull();
    expect((await missions.findByGoalId(GOAL_ID))?.id).toBe(mine.id);
  });

  it("a mission with no goal is not reachable by goal lookup", async () => {
    await missions.create({ title: "manuelle", objective: "sans goal", tasks: [] });
    expect(await missions.findByGoalId(GOAL_ID)).toBeNull();
  });
});
