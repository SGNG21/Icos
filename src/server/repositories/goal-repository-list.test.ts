import { describe, expect, it } from "vitest";

import type { GoalPlanPreview, HighLevelGoal } from "@/core/contracts/high-level-goal";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryGoalRepository } from "@/server/services/in-memory/goal-repository";

const goal = (id: string, createdAt: string): HighLevelGoal => ({
  id,
  title: id,
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: {},
  createdAt,
});

const preview = (id: string): GoalPlanPreview => ({
  goalId: id,
  missionTitle: id,
  missionObjective: "o",
  tasks: [],
});

describe("GoalRepository.list", () => {
  it("returns goals newest first with their status and mission lineage", async () => {
    const repo = new InMemoryGoalRepository(new InMemoryAuditLog());
    await repo.create(goal("g-old", "2026-10-01T00:00:00.000Z"), preview("g-old"));
    await repo.create(goal("g-new", "2026-10-02T00:00:00.000Z"), preview("g-new"));
    await repo.setConverted("g-old", "m-1");

    const all = await repo.list();
    expect(all.map((r) => r.goal.id)).toEqual(["g-new", "g-old"]);
    expect(all[1]).toMatchObject({ status: "converted", resultingMissionId: "m-1" });
    expect(all[0]).toMatchObject({ status: "pending", resultingMissionId: null });
  });

  it("filters by status and honours a limit", async () => {
    const repo = new InMemoryGoalRepository(new InMemoryAuditLog());
    await repo.create(goal("a", "2026-10-01T00:00:00.000Z"), preview("a"));
    await repo.create(goal("b", "2026-10-02T00:00:00.000Z"), preview("b"));
    await repo.setConverted("b", "m-2");

    expect((await repo.list({ status: "converted" })).map((r) => r.goal.id)).toEqual(["b"]);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });
});
