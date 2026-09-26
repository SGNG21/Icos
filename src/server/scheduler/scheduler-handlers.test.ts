import { describe, expect, it, vi } from "vitest";

import type { ScheduledJob } from "@/core/contracts/scheduler";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { PermanentJobError } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { InMemoryAutonomousMissionRuntimeRepository } from "@/server/services/in-memory/autonomous-mission-runtime-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

const signal = new AbortController().signal;
const jobOf = (kind: ScheduledJob["kind"], payload: Record<string, unknown>): ScheduledJob => ({
  id: "job-1",
  kind,
  payload,
  payloadHash: "h",
  idempotencyKey: "k",
  state: "running",
  priority: 0,
  nextRunAt: new Date(),
  attemptCount: 1,
  maxAttempts: 5,
  backoffBaseMs: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

function setup() {
  const tasks = new InMemoryTaskRepository(new InMemoryAuditLog(), []);
  const missions = new InMemoryMissionRepository(tasks);
  const runtimeRepository = new InMemoryAutonomousMissionRuntimeRepository();
  const dispatch = vi.fn().mockResolvedValue({ workflowId: "wf" });
  const planner = {
    plan: vi.fn(async () => ({
      version: 1,
      tasks: [{ key: "a", title: "A", description: "do a", dependsOn: [] }],
    })),
  };
  const wakeup = { wake: vi.fn().mockResolvedValue(null) };
  const supervisor = new SupervisorService(missions, tasks, { dispatch }, {} as never);
  const handlers = createSchedulerHandlers({
    ignite: { missions, runtimeRepository, supervisor, planner: planner as never },
    missions,
    wakeup,
  });
  return { missions, dispatch, planner, wakeup, handlers };
}

describe("scheduler handlers", () => {
  it("start_mission creates the mission under the id fixed at enqueue and starts it", async () => {
    const f = setup();
    await f.handlers.start_mission(
      jobOf("start_mission", { title: "T", objective: "O", missionId: "mission-from-enqueue", goalId: "g-1" }),
      { signal },
    );
    expect((await f.missions.findById("mission-from-enqueue"))?.objective).toBe("O");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("start_mission is replay-safe (crash after the mission was created, job re-run)", async () => {
    const f = setup();
    const job = jobOf("start_mission", { title: "T", objective: "O", missionId: "m-replay", goalId: "g-1" });
    await f.handlers.start_mission(job, { signal });
    await f.handlers.start_mission(job, { signal });
    expect(await f.missions.list()).toHaveLength(1);
    expect(f.planner.plan).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("wake_mission wakes an existing mission and fails permanently for a missing one", async () => {
    const f = setup();
    await f.missions.create({ id: "m-1", title: "T", objective: "O", tasks: [] });
    await f.handlers.wake_mission(jobOf("wake_mission", { missionId: "m-1" }), { signal });
    expect(f.wakeup.wake).toHaveBeenCalledWith("m-1");

    await expect(
      f.handlers.wake_mission(jobOf("wake_mission", { missionId: "ghost" }), { signal }),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("rejects a malformed payload permanently", async () => {
    const f = setup();
    await expect(f.handlers.start_mission(jobOf("start_mission", { title: "T" }), { signal })).rejects.toBeInstanceOf(
      PermanentJobError,
    );
  });
});
