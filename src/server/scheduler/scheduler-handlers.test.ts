import { describe, expect, it, vi } from "vitest";

import type { ScheduledJob } from "@/core/contracts/scheduler";
import { modelAllowlist } from "@/core/autonomy/model-allowlist";
import type { AutonomyCompositionPolicy } from "@/server/usecases/start-autonomous-mission";
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

function setup(policy: AutonomyCompositionPolicy = {}) {
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
    ignite: { missions, runtimeRepository, supervisor, planner: planner as never, ...policy },
    missions,
    wakeup,
  });
  return { missions, runtimeRepository, dispatch, planner, wakeup, handlers };
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

  it("supervisor_observe without a composed supervisor fails permanently, never silently", async () => {
    const f = setup();
    await expect(
      f.handlers.supervisor_observe(jobOf("supervisor_observe", { observationKey: "x", tenantId: "t", intervalMs: 60_000 }), {
        signal,
      }),
    ).rejects.toThrow("SCHEDULER_SUPERVISOR_UNAVAILABLE");
  });

  it("rejects a malformed payload permanently", async () => {
    const f = setup();
    await expect(f.handlers.start_mission(jobOf("start_mission", { title: "T" }), { signal })).rejects.toBeInstanceOf(
      PermanentJobError,
    );
  });

  /*
   * P0-E. La demande du propriétaire voyage dans le job durable et doit se retrouver
   * DANS LA LIGNE DE RUNTIME PERSISTÉE, pas seulement dans un retour de résolveur.
   */
  it("carries the admitted caps (30 min / 20 cycles / 2 replans) into the persisted runtime", async () => {
    const f = setup();
    await f.handlers.start_mission(
      jobOf("start_mission", {
        title: "T",
        objective: "O",
        missionId: "m-caps",
        bounds: { maxRuntimeMs: 1_800_000, maxCycles: 20, maxReplans: 2 },
      }),
      { signal },
    );

    const runtime = await f.runtimeRepository.get("m-caps");
    expect(runtime?.maxRuntimeMs).toBe(30 * 60 * 1000);
    expect(runtime?.maxCycles).toBe(20);
    expect(runtime?.maxReplans).toBe(2);
  });

  it("keeps the historical caps when the job admits none", async () => {
    const f = setup();
    await f.handlers.start_mission(
      jobOf("start_mission", { title: "T", objective: "O", missionId: "m-default" }),
      { signal },
    );

    const runtime = await f.runtimeRepository.get("m-default");
    expect(runtime?.maxRuntimeMs).toBe(60 * 60 * 1000);
    expect(runtime?.maxCycles).toBe(100);
    expect(runtime?.maxReplans).toBe(5);
  });

  it("refuses a malformed caps request permanently instead of ignoring it", async () => {
    const f = setup();
    await expect(
      f.handlers.start_mission(
        jobOf("start_mission", { title: "T", objective: "O", missionId: "m-bad", bounds: { maxCycles: 0 } }),
        { signal },
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
    await expect(
      f.handlers.start_mission(
        jobOf("start_mission", {
          title: "T",
          objective: "O",
          missionId: "m-bad-2",
          computePolicy: { allowedModels: "cheap" },
        }),
        { signal },
      ),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  /* P0-F: la politique du goal traverse le job, et le refus l'emporte sur l'allumage. */
  it("carries a goal compute policy and REFUSES a model the system does not permit", async () => {
    const f = setup({
      systemModelAllowlist: modelAllowlist(["cheap-model"]),
      plannerCompute: { modelId: "cheap-model" },
    });

    await expect(
      f.handlers.start_mission(
        jobOf("start_mission", {
          title: "T",
          objective: "O",
          missionId: "m-policy",
          computePolicy: { allowedModels: ["expensive-model"] },
        }),
        { signal },
      ),
    ).rejects.toThrow(/COMPUTE_REFUSED/);
    expect(await f.missions.findById("m-policy")).toBeTruthy();
    expect(await f.runtimeRepository.get("m-policy")).toBeNull();
  });
});
