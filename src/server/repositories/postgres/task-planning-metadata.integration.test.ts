import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { tasks } from "@/server/database/schema";
import type { MissionPlan } from "@/server/mission/mission-plan";

const DATABASE_URL = TEST_DATABASE_URL;

/*
 * Durable proof that CORE3 task planning metadata originates from the planner,
 * is persisted, and survives restart and replan (mission N10/N11).
 *
 * Before migration 0041 `taskToRow()` persisted only
 * id/title/description/status/assigned_agent_id/timestamps, so every planning
 * field built by prepareTaskCreation was validated and then silently dropped.
 * applyPlan additionally hardcoded riskClass/priority/attemptBudget, so planner
 * output could not influence execution at all.
 */

const opened = new Set<Container>();

async function freshProcess(): Promise<Container> {
  const env = loadEnv({
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
    OMNIROUTE_API_KEY: "core3-m2-test-key",
    ICOS_REVIEWER_MODEL: "core3-m2-reviewer",
  });
  const container = await buildPostgresContainer(
    DATABASE_URL,
    undefined,
    env,
  );
  opened.add(container);
  return container;
}

const richPlan: MissionPlan = {
  version: 1,
  tasks: [
    {
      key: "audit",
      title: "Audit the module",
      description: "Read only, no writes",
      dependsOn: [],
      objective: "Understand current behaviour",
      instructions: "Read src/, write findings",
      successCriteria: [
        "findings recorded",
        "no files modified",
      ],
      requiredCapabilities: ["typescript", "review"],
      riskClass: "read_only",
      allowedFileScope: ["src/**", "docs/**"],
      expectedArtifacts: ["audit-report.md"],
      priority: 1,
      attemptBudget: 2,
      reviewPolicy: "never",
      integrationPolicy: "no-integration",
    },
    {
      key: "change",
      title: "Apply the change",
      description: "Sensitive write",
      dependsOn: ["audit"],
      objective: "Implement the improvement",
      instructions: "Edit carefully, keep tests green",
      successCriteria: ["tests pass"],
      requiredCapabilities: ["typescript"],
      riskClass: "sensitive",
      allowedFileScope: ["src/server/**"],
      expectedArtifacts: ["diff", "test-output"],
      priority: 5,
      attemptBudget: 4,
      reviewPolicy: "always",
      integrationPolicy: "gate-required",
    },
  ],
};

describe("PostgreSQL CORE3 task planning metadata", () => {
  afterEach(async () => {
    for (const container of [...opened]) {
      opened.delete(container);
      await container.close();
    }
  });

  const seedMission = async (container: Container) => {
    if (!container.db) {
      throw new Error("PostgreSQL handle missing");
    }
    await container.db.execute(
      sql`TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE`,
    );
    return await container.mission.create({
      title: "M2 mission",
      objective: "Prove planner metadata is durable",
      goalId: `goal-${randomUUID()}`,
      tasks: [],
    });
  };

  it("persists planner-supplied metadata instead of hardcoded defaults", async () => {
    const container = await freshProcess();
    const mission = await seedMission(container);

    const applied = await container.mission.applyPlan(
      mission.id,
      richPlan,
    );
    expect(applied).toHaveLength(2);

    const auditMissionTask = applied.find(
      (t) => t.title === "Audit the module",
    )!;
    const changeMissionTask = applied.find(
      (t) => t.title === "Apply the change",
    )!;

    const audit = await container.tasks.getById(
      auditMissionTask.taskId,
    );
    const change = await container.tasks.getById(
      changeMissionTask.taskId,
    );

    // read_only / priority 1 / budget 2 are the PLANNER's values, and the old
    // hardcoded literals were reversible / 3 / 3.
    expect(audit?.riskClass).toBe("read_only");
    expect(audit?.priority).toBe(1);
    expect(audit?.attemptBudget).toBe(2);
    expect(audit?.reviewPolicy).toBe("never");
    expect(audit?.objective).toBe(
      "Understand current behaviour",
    );
    expect(audit?.instructions).toBe(
      "Read src/, write findings",
    );
    expect(audit?.successCriteria).toEqual([
      "findings recorded",
      "no files modified",
    ]);
    expect(audit?.requiredCapabilities).toEqual([
      "typescript",
      "review",
    ]);
    expect(audit?.allowedFileScope).toEqual([
      "src/**",
      "docs/**",
    ]);
    expect(audit?.expectedArtifacts).toEqual([
      "audit-report.md",
    ]);
    expect(audit?.integrationPolicy).toBe(
      "no-integration",
    );

    expect(change?.riskClass).toBe("sensitive");
    expect(change?.priority).toBe(5);
    expect(change?.attemptBudget).toBe(4);
    expect(change?.reviewPolicy).toBe("always");

    // Two tasks in one plan now carry DIFFERENT envelopes — impossible before.
    expect(audit?.riskClass).not.toBe(
      change?.riskClass,
    );
    expect(audit?.priority).not.toBe(
      change?.priority,
    );
  });

  it("carries mission/goal/plan lineage onto the canonical Task", async () => {
    const container = await freshProcess();
    const mission = await seedMission(container);

    const applied = await container.mission.applyPlan(
      mission.id,
      richPlan,
    );
    const stored = await container.tasks.getById(
      applied[0].taskId,
    );

    const lineage = await container.mission.listPlanLineage!(
      mission.id,
    );

    expect(stored?.missionId).toBe(mission.id);
    expect(stored?.goalId).toBe(
      (await container.mission.findById(mission.id))
        ?.goalId,
    );
    expect(stored?.planId).toBe(lineage[0].planId);
  });

  it("survives a process restart", async () => {
    const first = await freshProcess();
    const mission = await seedMission(first);
    const applied = await first.mission.applyPlan(
      mission.id,
      richPlan,
    );
    const taskId = applied.find(
      (t) => t.title === "Apply the change",
    )!.taskId;

    // Close the container entirely: nothing survives in memory.
    opened.delete(first);
    await first.close();

    const restarted = await freshProcess();
    const reloaded = await restarted.tasks.getById(
      taskId,
    );

    expect(reloaded?.riskClass).toBe("sensitive");
    expect(reloaded?.priority).toBe(5);
    expect(reloaded?.attemptBudget).toBe(4);
    expect(reloaded?.reviewPolicy).toBe("always");
    expect(reloaded?.successCriteria).toEqual([
      "tests pass",
    ]);
    expect(reloaded?.expectedArtifacts).toEqual([
      "diff",
      "test-output",
    ]);
    expect(reloaded?.allowedFileScope).toEqual([
      "src/server/**",
    ]);
    expect(reloaded?.integrationPolicy).toBe(
      "gate-required",
    );
  });

  it("gives replacement tasks the new plan's metadata while historical tasks keep their own", async () => {
    const container = await freshProcess();
    const mission = await seedMission(container);

    const applied = await container.mission.applyPlan(
      mission.id,
      richPlan,
    );
    const originalTaskId = applied.find(
      (t) => t.title === "Apply the change",
    )!.taskId;

    const replacement: MissionPlan = {
      version: 1,
      tasks: [
        {
          key: "redo",
          title: "Replacement approach",
          dependsOn: [],
          objective: "Different approach",
          riskClass: "reversible",
          priority: 2,
          attemptBudget: 7,
          reviewPolicy: "if_risky",
          successCriteria: ["new criterion"],
        },
      ],
    };

    const after = await container.mission.replacePlan!(
      mission.id,
      replacement,
    );

    const newMissionTask = after.find(
      (t) => t.title === "Replacement approach",
    )!;
    const newTask = await container.tasks.getById(
      newMissionTask.taskId,
    );

    expect(newTask?.riskClass).toBe("reversible");
    expect(newTask?.priority).toBe(2);
    expect(newTask?.attemptBudget).toBe(7);
    expect(newTask?.successCriteria).toEqual([
      "new criterion",
    ]);

    /*
     * Mission N10: a task created under P1 stays P1 forever. The superseded
     * task's canonical Task must keep its ORIGINAL envelope and plan id — it is
     * never rewritten to look like it came from the current plan.
     */
    const historical = await container.tasks.getById(
      originalTaskId,
    );
    const lineage = await container.mission.listPlanLineage!(
      mission.id,
    );

    expect(historical?.riskClass).toBe("sensitive");
    expect(historical?.priority).toBe(5);
    expect(historical?.attemptBudget).toBe(4);
    expect(historical?.planId).toBe(
      lineage[0].planId,
    );
    expect(newTask?.planId).toBe(lineage[1].planId);
    expect(historical?.planId).not.toBe(
      newTask?.planId,
    );
  });

  it("defaults a legacy plan with no planning metadata to the documented values", async () => {
    const container = await freshProcess();
    const mission = await seedMission(container);

    const applied = await container.mission.applyPlan(
      mission.id,
      {
        version: 1,
        tasks: [
          {
            key: "legacy",
            title: "Legacy task",
            description: "no metadata",
            dependsOn: [],
          },
        ],
      },
    );

    const stored = await container.tasks.getById(
      applied[0].taskId,
    );

    expect(stored?.riskClass).toBe("reversible");
    expect(stored?.priority).toBe(3);
    expect(stored?.attemptBudget).toBe(3);
    expect(stored?.reviewPolicy).toBe("if_risky");
    expect(stored?.objective).toBe("Legacy task");
    expect(stored?.instructions).toBe("no metadata");
  });

  it("refuses an unrecognized risk class at the database boundary", async () => {
    const container = await freshProcess();
    const mission = await seedMission(container);
    const applied = await container.mission.applyPlan(
      mission.id,
      richPlan,
    );

    // Even a caller bypassing the planning layer cannot store an unknown class.
    await expect(
      container.db!
        .update(tasks)
        .set({ riskClass: "catastrophic" })
        .where(eq(tasks.id, applied[0].taskId)),
    ).rejects.toThrow();
  });

  it("refuses an out-of-range priority and a zero attempt budget at the database boundary", async () => {
    const container = await freshProcess();
    const mission = await seedMission(container);
    const applied = await container.mission.applyPlan(
      mission.id,
      richPlan,
    );
    const id = applied[0].taskId;

    await expect(
      container.db!
        .update(tasks)
        .set({ priority: 9 })
        .where(eq(tasks.id, id)),
    ).rejects.toThrow();

    await expect(
      container.db!
        .update(tasks)
        .set({ attemptBudget: 0 })
        .where(eq(tasks.id, id)),
    ).rejects.toThrow();

    await expect(
      container.db!
        .update(tasks)
        .set({ reviewPolicy: "sometimes" })
        .where(eq(tasks.id, id)),
    ).rejects.toThrow();
  });
});
