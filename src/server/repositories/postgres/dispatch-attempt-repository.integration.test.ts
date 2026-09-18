import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";

const DATABASE_URL = "postgres://coco@localhost:5432/icos_n23_probe";

describe("PostgresDispatchAttemptRepository N2.3", () => {
  const handle = createDatabase(DATABASE_URL);

  beforeAll(async () => {
    // Force the lazy postgres.js connection now.
    await handle.db.select().from(missions).limit(1);
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    // Base probe partagée avec les autres tests N2 : TRUNCATE CASCADE sur les
    // tables racine (même pattern que N2.4), dans la base jetable uniquement.
    await handle.db.execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));

    const now = new Date();

    await handle.db.insert(tasks).values({
      id: "task-a",
      title: "Task A",
      description: "A",
      status: "draft",
      assignedAgentId: null,
      createdAt: now,
      updatedAt: now,
    });

    await handle.db.insert(missions).values({
      id: "mission-a",
      title: "Mission A",
      objective: "N2.3 PostgreSQL durability",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    await handle.db.insert(missionTasks).values({
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

  it("prepare persiste atomiquement queued + prepared et est idempotent", async () => {
    const repo = new PostgresDispatchAttemptRepository(handle.db);

    const first = await repo.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
      workerKind: "agent",
    });

    const second = await repo.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
      workerKind: "agent",
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.attempt.id).toBe(first.attempt.id);

    const storedTasks = await handle.db.select().from(missionTasks);

    expect(storedTasks).toHaveLength(1);
    expect(storedTasks[0]?.status).toBe("queued");

    const storedAttempts = await handle.db.select().from(dispatchAttempts);

    expect(storedAttempts).toHaveLength(1);
    expect(storedAttempts[0]?.state).toBe("prepared");
    expect(storedAttempts[0]?.workflowId).toBe("icos-task-task-a");
  });

  it("transitionne prepared vers dispatched", async () => {
    const repo = new PostgresDispatchAttemptRepository(handle.db);

    const attempt = await repo.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
    });

    expect(attempt.acquired).toBe(true);
    await repo.markDispatched(attempt.attempt.id);

    const stored = await repo.getByWorkflowId("icos-task-task-a");

    expect(stored).not.toBeNull();
    expect(stored?.state).toBe("dispatched");
    expect(stored?.dispatchedAt).toBeInstanceOf(Date);
  });

  it("rend dispatched/completed idempotents et refuse les workflows inconnus", async () => {
    const repo = new PostgresDispatchAttemptRepository(handle.db);
    const prepared = await repo.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
    });

    await repo.markDispatched(prepared.attempt.id);
    await repo.markDispatched(prepared.attempt.id);
    await repo.markCompletedByWorkflowId("icos-task-task-a");
    await repo.markCompletedByWorkflowId("icos-task-task-a");

    expect((await repo.getByWorkflowId("icos-task-task-a"))?.state).toBe("completed");
    await expect(repo.markCompletedByWorkflowId("unknown-workflow")).rejects.toThrow(
      "DISPATCH_ATTEMPT_UNKNOWN_WORKFLOW",
    );
  });

  it("ferme durablement les anciennes tentatives quand une nouvelle devient autoritative", async () => {
    const repo = new PostgresDispatchAttemptRepository(handle.db);
    const first = await repo.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
    });
    await repo.markDispatched(first.attempt.id);

    const second = await repo.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 2,
      workflowId: "icos-task-task-a-attempt-2",
      prompt: "A retry",
    });

    expect(await repo.getByWorkflowId("icos-task-task-a")).toMatchObject({
      state: "failed",
      lastError: "DISPATCH_ATTEMPT_SUPERSEDED",
    });
    expect(second.attempt.state).toBe("prepared");
    expect(await repo.listNonTerminalByMissionTaskId("mission-task-a")).toEqual([
      second.attempt,
    ]);
  });

  it("retrouve un prepared depuis une nouvelle instance repository après crash", async () => {
    const processA = new PostgresDispatchAttemptRepository(handle.db);

    await processA.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
    });

    // Nouveau repository = nouveau processus logique.
    const processB = new PostgresDispatchAttemptRepository(handle.db);

    const prepared = await processB.listPrepared("mission-a");

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.missionTaskId).toBe("mission-task-a");
    expect(prepared[0]?.taskId).toBe("task-a");
    expect(prepared[0]?.workflowId).toBe("icos-task-task-a");
    expect(prepared[0]?.state).toBe("prepared");
  });

  it("refuse de réutiliser le même attempt avec un autre workflowId", async () => {
    const repo = new PostgresDispatchAttemptRepository(handle.db);

    await repo.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a",
      prompt: "A",
    });

    await expect(
      repo.prepare({
        missionId: "mission-a",
        missionTaskId: "mission-task-a",
        taskId: "task-a",
        attempt: 1,
        workflowId: "icos-task-task-a-WRONG",
        prompt: "A",
      }),
    ).rejects.toThrow("DISPATCH_ATTEMPT_CONFLICT");
  });

  it("allows another process to claim a prepared attempt after the recovery lease expires", async () => {
    const repoA = new PostgresDispatchAttemptRepository(handle.db);

    const prepared = await repoA.prepare({
      missionId: "mission-a",
      missionTaskId: "mission-task-a",
      taskId: "task-a",
      attempt: 1,
      workflowId: "icos-task-task-a-lease-expiry",
      prompt: "A",
      workerKind: "agent",
    });

    expect(prepared.acquired).toBe(true);

    const firstClaim = await repoA.claimPrepared(prepared.attempt.id, "recoverer-a", 50);

    expect(firstClaim).toBe(true);

    const immediateSecondClaim = await repoA.claimPrepared(prepared.attempt.id, "recoverer-b", 50);

    expect(immediateSecondClaim).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const repoB = new PostgresDispatchAttemptRepository(handle.db);

    const expiredLeaseClaim = await repoB.claimPrepared(prepared.attempt.id, "recoverer-b", 50);

    expect(expiredLeaseClaim).toBe(true);

    const stored = await repoB.getByWorkflowId("icos-task-task-a-lease-expiry");

    expect(stored?.state).toBe("prepared");
  });
});
