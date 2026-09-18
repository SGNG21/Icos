import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase } from "@/server/database/client";
import {
  dispatchAttempts,
  missionTasks,
  missions,
  tasks,
} from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import type {
  TaskExecutionDispatchInput,
  TaskExecutionDispatcher,
} from "@/server/execution/ports";

const DATABASE_URL =
  TEST_DATABASE_URL;

describe("N2.3 PostgreSQL crash/restart dispatch recovery", () => {
  const handleA = createDatabase(DATABASE_URL);
  const handleB = createDatabase(DATABASE_URL);

  beforeAll(async () => {
    await handleA.db.select().from(missions).limit(1);
    await handleB.db.select().from(missions).limit(1);
  });

  afterAll(async () => {
    await handleA.close();
    await handleB.close();
  });

  beforeEach(async () => {
    // La base probe est partagée avec les autres tests N2 : des lignes
    // audit_entries référencent d'anciens tasks.id, ce qui fait échouer un
    // DELETE séquentiel (FK restrict). Même pattern que N2.4 : TRUNCATE
    // CASCADE sur les tables racine, dans la base jetable uniquement.
    await handleA.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE",
      ),
    );

    const now = new Date();

    await handleA.db.insert(tasks).values({
      id: "task-a",
      title: "Task A",
      description: "A",
      status: "draft",
      assignedAgentId: null,
      createdAt: now,
      updatedAt: now,
    });

    await handleA.db.insert(missions).values({
      id: "mission-a",
      title: "Mission A",
      objective: "Crash recovery",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    await handleA.db.insert(missionTasks).values({
      id: "mission-task-a",
      missionId: "mission-a",
      title: "Task A",
      description: "A",
      dependsOn: [],
      status: "draft",
      workerKind: "agent",
      capability: null,
      taskId: "task-a",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("process B reprend le prepared laissé par process A avec le même workflowId", async () => {
    const repoA =
      new PostgresDispatchAttemptRepository(handleA.db);

    await repoA.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
      workerKind: "agent",
    });

    // Process A meurt ici :
    // DB = prepared + queued, aucun markDispatched.

    const taskRepoB = new PostgresTaskRepository(handleB.db);
    const missionRepoB = new PostgresMissionRepository(
      handleB.db,
      taskRepoB,
    );
    const dispatchRepoB =
      new PostgresDispatchAttemptRepository(handleB.db);
    const durableMemoryB =
      new PostgresDurableMemory(handleB.db);

    const dispatch = vi.fn(
      async (input: TaskExecutionDispatchInput) => ({
        workflowId:
          input.workflowId ?? `icos-task-${input.taskId}`,
      }),
    );

    const supervisorB = new SupervisorService(
      missionRepoB,
      taskRepoB,
      { dispatch } as TaskExecutionDispatcher,
      durableMemoryB,
      dispatchRepoB,
    );

    await supervisorB.reconcilePreparedDispatches(
      "mission-a",
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].workflowId).toBe(
      "icos-task-task-a",
    );

    const stored =
      await dispatchRepoB.getByWorkflowId(
        "icos-task-task-a",
      );

    expect(stored?.state).toBe("dispatched");

    const missionTask =
      await missionRepoB.getMissionTaskById(
        "mission-task-a",
      );

    expect(missionTask?.status).toBe("queued");
  });
});
