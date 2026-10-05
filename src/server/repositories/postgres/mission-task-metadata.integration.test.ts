import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { PostgresMissionRepository } from "./mission-repository";
import { PostgresTaskRepository } from "./task-repository";
import { decideWorkspaceAllocation } from "@/server/supervisor/workspace-allocation-policy";

/*
 * DEFECT 24 — `create()` must not INVENT planning metadata.
 *
 * It hardcoded `riskClass: 'reversible'`, `allowedFileScope: []`, priority 3, attemptBudget
 * 3 and reviewPolicy 'if_risky' as literals. Harmless while that metadata was decorative;
 * load-bearing once M9 made governance the default, because a task claiming to be a WRITER
 * while declaring NO scope is one the allocation policy must refuse — so every inline-created
 * task was unrunnable, and the reason was a constant nobody had chosen.
 *
 * There is ONE creation authority (`prepareTaskCreation`) and ONE source of defaults
 * (`taskSchema`). Declared values pass through; omitted values fall to the schema. Nothing is
 * invented here, so no second planning contract exists.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const handles: DatabaseHandle[] = [];

function repo() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const taskRepo = new PostgresTaskRepository(handle.db);
  return { handle, taskRepo, missions: new PostgresMissionRepository(handle.db, taskRepo) };
}

const seed = repo();

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("DEFECT 24 — inline mission task metadata", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE workforce_assignments, missions, tasks, mission_tasks, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items RESTART IDENTITY CASCADE",
      ),
    );
  });

  it("PERSISTS DECLARED metadata instead of hardcoded literals", async () => {
    const ctx = repo();
    const mission = await ctx.missions.create({
      title: "Manual mission",
      objective: "Do a scoped thing",
      tasks: [
        {
          title: "Edit the widget",
          description: "Change src/widget",
          dependsOn: [],
          workerKind: null,
          capability: null,
          riskClass: "sensitive",
          allowedFileScope: ["src/widget/**"],
          requiredCapabilities: ["code-generation"],
          attemptBudget: 5,
          reviewPolicy: "always",
        },
      ],
    });

    const missionTasks = await ctx.missions.listTasks(mission.id);
    const task = await ctx.taskRepo.getById(missionTasks[0]!.taskId);

    /* What the caller declared is what the canonical Task carries. */
    expect(task?.riskClass).toBe("sensitive");
    expect(task?.allowedFileScope).toEqual(["src/widget/**"]);
    expect(task?.requiredCapabilities).toEqual(["code-generation"]);
    expect(task?.attemptBudget).toBe(5);
    expect(task?.reviewPolicy).toBe("always");
  });

  it("A DECLARED WRITER IS NOW GOVERNABLE — the defect, closed", async () => {
    const ctx = repo();
    const mission = await ctx.missions.create({
      title: "Manual mission",
      objective: "Do a scoped thing",
      tasks: [
        {
          title: "Edit the widget",
          description: "Change src/widget",
          dependsOn: [],
          workerKind: null,
          capability: null,
          riskClass: "reversible",
          allowedFileScope: ["src/widget/**"],
        },
      ],
    });
    const missionTasks = await ctx.missions.listTasks(mission.id);
    const task = await ctx.taskRepo.getById(missionTasks[0]!.taskId);

    /*
     * Before this fix the same call produced `allowedFileScope: []`, so the allocation
     * policy REFUSED it and the task blocked — for a value the caller never chose.
     */
    const decision = decideWorkspaceAllocation({
      taskId: task!.id,
      title: task!.title,
      riskClass: task!.riskClass,
      allowedFileScope: task!.allowedFileScope,
    });
    expect(decision.kind).toBe("GOVERNED");
  });

  it("OMITTED metadata falls through to the CANONICAL schema defaults", async () => {
    const ctx = repo();
    const mission = await ctx.missions.create({
      title: "Manual mission",
      objective: "Unspecified work",
      tasks: [{ title: "Something", description: "d", dependsOn: [], workerKind: null, capability: null }],
    });
    const missionTasks = await ctx.missions.listTasks(mission.id);
    const task = await ctx.taskRepo.getById(missionTasks[0]!.taskId);

    /*
     * Defaults, from `taskSchema` — one source of truth, not a second set of literals in
     * the repository. An undeclared task is still treated as a writer, which is why it then
     * fails closed below rather than silently running ungoverned.
     */
    expect(task?.riskClass).toBe("reversible");
    expect(task?.allowedFileScope).toEqual([]);
    expect(task?.attemptBudget).toBe(3);

    expect(
      decideWorkspaceAllocation({
        taskId: task!.id,
        title: task!.title,
        riskClass: task!.riskClass,
        allowedFileScope: task!.allowedFileScope,
      }).kind,
    ).toBe("REFUSED");
  });

  it("A DECLARED READ-ONLY task needs no workspace", async () => {
    const ctx = repo();
    const mission = await ctx.missions.create({
      title: "Manual mission",
      objective: "Inspect only",
      tasks: [
        {
          title: "Inspect",
          description: "look",
          dependsOn: [],
          workerKind: null,
          capability: null,
          riskClass: "read_only",
        },
      ],
    });
    const missionTasks = await ctx.missions.listTasks(mission.id);
    const task = await ctx.taskRepo.getById(missionTasks[0]!.taskId);

    expect(task?.riskClass).toBe("read_only");
    expect(
      decideWorkspaceAllocation({
        taskId: task!.id,
        title: task!.title,
        riskClass: task!.riskClass,
        allowedFileScope: task!.allowedFileScope,
      }).kind,
    ).toBe("NOT_REQUIRED");
  });
});
