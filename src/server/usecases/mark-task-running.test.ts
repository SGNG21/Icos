import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";

import { markTaskRunning } from "./mark-task-running";

async function fixture() {
  const auditLog = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(auditLog, []);
  const created = await tasks.create({ title: "Analyse" });
  if (!created.ok) throw new Error("seed");
  const queued = await tasks.transition(created.task.id, "queued");
  if (!queued.ok) throw new Error("seed queued");
  return { tasks, taskId: created.task.id };
}

async function dispatchFixture() {
  const auditLog = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(auditLog, []);
  const missions = new InMemoryMissionRepository(tasks);
  const mission = await missions.create({
    title: "Started callback",
    objective: "Fence attempt authority",
    tasks: [{ title: "Run", dependsOn: [] }],
  });
  const missionTask = (await missions.listTasks(mission.id))[0];
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(missions, tasks);
  const first = await dispatchAttempts.prepare({
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    attempt: 1,
    workflowId: `icos-task-${missionTask.taskId}`,
    prompt: missionTask.title,
  });
  await dispatchAttempts.markDispatched(first.attempt.id);
  return { tasks, missions, mission, missionTask, dispatchAttempts, first };
}

describe("markTaskRunning", () => {
  it("applique queued → running", async () => {
    const { tasks, taskId } = await fixture();
    const result = await markTaskRunning({ tasks }, { taskId, workflowId: "wf-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyRunning).toBe(false);
    expect((await tasks.getById(taskId))?.status).toBe("running");
  });

  it("est idempotent : un rejeu retourne alreadyRunning sans erreur", async () => {
    const { tasks, taskId } = await fixture();
    await markTaskRunning({ tasks }, { taskId, workflowId: "wf-1" });
    const replay = await markTaskRunning({ tasks }, { taskId, workflowId: "wf-1" });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.alreadyRunning).toBe(true);
  });

  it("refuse la remontée d'un statut terminal", async () => {
    const { tasks, taskId } = await fixture();
    await tasks.transition(taskId, "running");
    await tasks.transition(taskId, "succeeded");
    const result = await markTaskRunning({ tasks }, { taskId, workflowId: "wf-1" });
    expect(result).toMatchObject({ ok: false, reason: "invalid_transition" });
  });

  it("refuse une tâche inconnue", async () => {
    const { tasks } = await fixture();
    const result = await markTaskRunning(
      { tasks },
      { taskId: "task-inconnue", workflowId: "wf-1" },
    );
    expect(result).toMatchObject({ ok: false, reason: "task_not_found" });
  });

  it("refuse un workflow inconnu lorsque le ledger durable est disponible", async () => {
    const { tasks, taskId } = await fixture();
    const dispatchAttempts = {
      authorizeStart: async () => ({
        ok: false,
        reason: "workflow_not_found" as const,
        message: "workflow d'exécution non corrélé",
      }),
    } as unknown as import("@/core/contracts/dispatch-attempt").DispatchAttemptRepository;

    const result = await markTaskRunning(
      { tasks, dispatchAttempts },
      { taskId, workflowId: "unknown-workflow" },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_transition",
      message: "workflow d'exécution non corrélé",
    });
    expect((await tasks.getById(taskId))?.status).toBe("queued");
  });

  it("refuse l'ancienne tentative et accepte la nouvelle tentative autoritative", async () => {
    const f = await dispatchFixture();
    const second = await f.dispatchAttempts.prepare({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      attempt: 2,
      workflowId: `${f.first.attempt.workflowId}-attempt-2`,
      prompt: "retry",
    });
    await f.dispatchAttempts.markDispatched(second.attempt.id);

    const stale = await markTaskRunning(
      { tasks: f.tasks, dispatchAttempts: f.dispatchAttempts },
      { taskId: f.missionTask.taskId, workflowId: f.first.attempt.workflowId },
    );
    expect(stale).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect((await f.tasks.getById(f.missionTask.taskId))?.status).toBe("queued");

    const current = await markTaskRunning(
      { tasks: f.tasks, dispatchAttempts: f.dispatchAttempts },
      { taskId: f.missionTask.taskId, workflowId: second.attempt.workflowId },
    );
    expect(current).toMatchObject({ ok: true, alreadyRunning: false });
  });

  it("refuse les tentatives historiques completed et failed", async () => {
    const completed = await dispatchFixture();
    await completed.dispatchAttempts.markCompletedByWorkflowId(completed.first.attempt.workflowId);
    expect(
      await markTaskRunning(
        { tasks: completed.tasks, dispatchAttempts: completed.dispatchAttempts },
        { taskId: completed.missionTask.taskId, workflowId: completed.first.attempt.workflowId },
      ),
    ).toMatchObject({ ok: false, reason: "invalid_transition" });

    const failed = await dispatchFixture();
    await failed.dispatchAttempts.markFailed(
      failed.first.attempt.id,
      "DISPATCH_PROVIDER_REJECTED",
    );
    expect(
      await markTaskRunning(
        { tasks: failed.tasks, dispatchAttempts: failed.dispatchAttempts },
        { taskId: failed.missionTask.taskId, workflowId: failed.first.attempt.workflowId },
      ),
    ).toMatchObject({ ok: false, reason: "invalid_transition" });
  });

  it("fence une ancienne callback suspendue avant la transition canonique", async () => {
    const f = await dispatchFixture();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.dispatchAttempts.setStartAuthorizationHookForTest?.(async () => {
      entered();
      await paused;
    });

    const staleCallback = markTaskRunning(
      { tasks: f.tasks, dispatchAttempts: f.dispatchAttempts },
      { taskId: f.missionTask.taskId, workflowId: f.first.attempt.workflowId },
    );
    await enteredPromise;
    const second = await f.dispatchAttempts.prepare({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      attempt: 2,
      workflowId: `${f.first.attempt.workflowId}-attempt-2`,
      prompt: "retry",
    });
    release();

    expect(await staleCallback).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect((await f.tasks.getById(f.missionTask.taskId))?.status).toBe("queued");
    expect(await f.dispatchAttempts.getByWorkflowId(second.attempt.workflowId)).toMatchObject({
      state: "prepared",
    });
  });

  it("sérialise deux callbacks concurrentes pour la même tentative courante", async () => {
    const f = await dispatchFixture();
    const transition = vi.spyOn(f.tasks, "transition");

    const [first, second] = await Promise.all([
      markTaskRunning(
        { tasks: f.tasks, dispatchAttempts: f.dispatchAttempts },
        { taskId: f.missionTask.taskId, workflowId: f.first.attempt.workflowId },
      ),
      markTaskRunning(
        { tasks: f.tasks, dispatchAttempts: f.dispatchAttempts },
        { taskId: f.missionTask.taskId, workflowId: f.first.attempt.workflowId },
      ),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(transition).toHaveBeenCalledTimes(1);
    expect((await f.tasks.getById(f.missionTask.taskId))?.status).toBe("running");
  });
});
