import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";

async function fixture() {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit, []);
  const missions = new InMemoryMissionRepository(tasks);
  const mission = await missions.create({
    title: "Dispatch preparation",
    objective: "Keep MissionTask and canonical Task aligned",
    tasks: [
      {
        title: "Prepare work",
        description: "Queue atomically",
        dependsOn: [],
      },
    ],
  });
  const missionTask = (await missions.listTasks(mission.id))[0];
  const repository = new InMemoryDispatchAttemptRepository(missions, tasks);
  const input = {
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    attempt: 1,
    workflowId: `icos-task-${missionTask.taskId}`,
    prompt: missionTask.description ?? missionTask.title,
  };

  return { tasks, missions, missionTask, repository, input };
}

describe("InMemoryDispatchAttemptRepository.prepare", () => {
  it("prépare une nouvelle tentative et persiste les deux états queued", async () => {
    const f = await fixture();

    const prepared = await f.repository.prepare(f.input);

    expect(prepared.acquired).toBe(true);
    expect(prepared.attempt).toMatchObject({
      missionId: f.input.missionId,
      missionTaskId: f.input.missionTaskId,
      taskId: f.input.taskId,
      workflowId: f.input.workflowId,
      state: "prepared",
    });
    expect((await f.tasks.getById(f.input.taskId))?.status).toBe("queued");
    expect((await f.missions.getMissionTaskById(f.input.missionTaskId))?.status).toBe("queued");
    expect(await f.repository.getByWorkflowId(f.input.workflowId)).toEqual(prepared.attempt);
  });

  it("rejoue la même tentative prepared sans transition queued vers queued", async () => {
    const f = await fixture();
    const transition = vi.spyOn(f.tasks, "transition");
    const updateMissionTaskStatus = vi.spyOn(f.missions, "updateMissionTaskStatus");

    const first = await f.repository.prepare(f.input);
    const replay = await f.repository.prepare(f.input);

    expect(replay).toEqual({ attempt: first.attempt, acquired: false });
    expect(transition).toHaveBeenCalledTimes(1);
    expect(updateMissionTaskStatus).toHaveBeenCalledTimes(1);
    expect(await f.repository.listPrepared()).toEqual([first.attempt]);
  });

  it("sérialise deux préparations concurrentes de la même tentative", async () => {
    const f = await fixture();

    const [first, second] = await Promise.all([
      f.repository.prepare(f.input),
      f.repository.prepare(f.input),
    ]);

    expect([first.acquired, second.acquired].sort()).toEqual([false, true]);
    expect(first.attempt).toEqual(second.attempt);
    expect(await f.repository.listPrepared()).toEqual([first.attempt]);
    expect((await f.tasks.getById(f.input.taskId))?.status).toBe("queued");
    expect((await f.missions.getMissionTaskById(f.input.missionTaskId))?.status).toBe("queued");
  });

  it("ferme les anciennes tentatives lorsque la suivante devient autoritative", async () => {
    const f = await fixture();
    const first = await f.repository.prepare(f.input);
    await f.repository.markDispatched(first.attempt.id);

    const second = await f.repository.prepare({
      ...f.input,
      attempt: 2,
      workflowId: `${f.input.workflowId}-attempt-2`,
    });

    expect((await f.repository.getByWorkflowId(f.input.workflowId))?.state).toBe("failed");
    expect((await f.repository.getByWorkflowId(f.input.workflowId))?.lastError).toBe(
      "DISPATCH_ATTEMPT_SUPERSEDED",
    );
    expect(second.attempt.state).toBe("prepared");
    expect(await f.repository.listNonTerminalByMissionTaskId(f.input.missionTaskId)).toEqual([
      second.attempt,
    ]);
  });

  it("refuse une tâche canonique terminale sans persister ni modifier la MissionTask", async () => {
    const f = await fixture();
    await f.tasks.transition(f.input.taskId, "queued");
    await f.tasks.transition(f.input.taskId, "running");
    await f.tasks.transition(f.input.taskId, "succeeded");

    await expect(f.repository.prepare(f.input)).rejects.toThrow(
      `Task ${f.input.taskId} cannot transition from succeeded to queued`,
    );

    expect(await f.repository.getByWorkflowId(f.input.workflowId)).toBeNull();
    expect((await f.missions.getMissionTaskById(f.input.missionTaskId))?.status).toBe("draft");
    expect((await f.tasks.getById(f.input.taskId))?.status).toBe("succeeded");
  });

  it("annule la mutation MissionTask si la transition canonique échoue", async () => {
    const f = await fixture();
    vi.spyOn(f.tasks, "transition").mockResolvedValueOnce({
      ok: false,
      reason: "audit_failed",
      message: "injected audit failure",
    });

    await expect(f.repository.prepare(f.input)).rejects.toThrow(
      `Task ${f.input.taskId} cannot transition from draft to queued`,
    );

    expect(await f.repository.getByWorkflowId(f.input.workflowId)).toBeNull();
    expect(await f.repository.listPrepared()).toEqual([]);
    expect((await f.missions.getMissionTaskById(f.input.missionTaskId))?.status).toBe("draft");
    expect((await f.tasks.getById(f.input.taskId))?.status).toBe("draft");
  });

  it("utilise le TaskRepository canonique partagé créé avec la MissionTask", async () => {
    const f = await fixture();
    const canonicalBefore = await f.tasks.getById(f.missionTask.taskId);

    expect(canonicalBefore?.status).toBe("draft");

    await f.repository.prepare(f.input);

    expect((await f.tasks.getById(f.missionTask.taskId))?.status).toBe("queued");
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("queued");
  });

  it("converges idempotently on an attempt already dispatched by a concurrent supervisor", async () => {
    const f = await fixture();
    const winner = await f.repository.prepare(f.input);
    await f.repository.markDispatched(winner.attempt.id);
    await f.missions.updateMissionTaskStatus(f.input.missionId, f.input.missionTaskId, "running");

    const loser = await f.repository.prepare(f.input);

    expect(loser.acquired).toBe(false);
    expect(loser.attempt).toMatchObject({ id: winner.attempt.id, state: "dispatched" });
    expect((await f.missions.getMissionTaskById(f.input.missionTaskId))?.status).toBe("running");
  });

  it("still rejects the same attempt with a foreign workflowId", async () => {
    const f = await fixture();
    const winner = await f.repository.prepare(f.input);
    await f.repository.markDispatched(winner.attempt.id);
    await expect(
      f.repository.prepare({ ...f.input, workflowId: "icos-task-other" }),
    ).rejects.toThrow("DISPATCH_ATTEMPT_CONFLICT");
  });
});
