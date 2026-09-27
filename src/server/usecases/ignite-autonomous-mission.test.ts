import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAutonomousMissionRuntimeRepository } from "@/server/services/in-memory/autonomous-mission-runtime-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { igniteAutonomousMission } from "@/server/usecases/ignite-autonomous-mission";

function setup(plan: () => Promise<unknown>) {
  const tasks = new InMemoryTaskRepository(new InMemoryAuditLog(), []);
  const missions = new InMemoryMissionRepository(tasks);
  const runtimeRepository = new InMemoryAutonomousMissionRuntimeRepository();
  const dispatch = vi.fn().mockResolvedValue({ workflowId: "wf" });
  const supervisor = new SupervisorService(missions, tasks, { dispatch }, {} as never);
  const planner = { plan: vi.fn(plan) };
  return { missions, runtimeRepository, dispatch, planner, deps: { missions, runtimeRepository, supervisor, planner: planner as never } };
}
const onePlan = async () => ({
  version: 1,
  tasks: [{ key: "a", title: "A", description: "do a", dependsOn: [] }],
});

describe("igniteAutonomousMission", () => {
  it("creates the mission under the imposed id and starts it", async () => {
    const f = setup(onePlan);
    const result = await igniteAutonomousMission(f.deps, { id: "m-1", title: "T", objective: "O", goalId: "g-1" });
    expect(result).toMatchObject({ missionId: "m-1", outcome: "started" });
    expect((await f.missions.findById("m-1"))?.title).toBe("T");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("is replay-safe: igniting the same id twice never creates a second mission or replans/redispatches", async () => {
    const f = setup(onePlan);
    await igniteAutonomousMission(f.deps, { id: "m-1", title: "T", objective: "O", goalId: "g-1" });
    await igniteAutonomousMission(f.deps, { id: "m-1", title: "T", objective: "O", goalId: "g-1" });
    expect(await f.missions.list()).toHaveLength(1);
    expect(f.planner.plan).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it("defers (durable runtime, recoverable) when starting fails after creation", async () => {
    const f = setup(async () => {
      throw new Error("AUTONOMY_PLANNER_PROVIDER_HTTP:503");
    });
    const result = await igniteAutonomousMission(f.deps, { id: "m-2", title: "T", objective: "O" });
    expect(result).toEqual({ missionId: "m-2", outcome: "deferred" });
    expect((await f.runtimeRepository.get("m-2"))?.state).toBe("running");
  });

  it("generates an id when none is imposed", async () => {
    const f = setup(onePlan);
    const result = await igniteAutonomousMission(f.deps, { title: "T", objective: "O" });
    expect(result.missionId).toMatch(/[0-9a-f-]{36}/);
  });
});
