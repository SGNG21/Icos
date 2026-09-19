import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let container: Container;

const dispatch = vi.fn(async (input: { workflowId?: string; taskId: string }) => ({
  workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
}));
const planner = {
  plan: vi.fn(async () => ({
    version: 1,
    tasks: [{ key: "a", title: "A", description: "Return exactly: OK", dependsOn: [] }],
  })),
};
const wake = vi.fn().mockResolvedValue(null);

function handlers() {
  const supervisor = new SupervisorService(
    container.mission,
    container.tasks,
    { dispatch } as never,
    container.durableMemory,
    container.dispatchAttempts,
  );
  return createSchedulerHandlers({
    ignite: {
      missions: container.mission,
      runtimeRepository: container.autonomousRuntime,
      supervisor,
      planner: planner as never,
    },
    missions: container.mission,
    wakeup: { wake },
  });
}
const newScheduler = (leaseMs = 60_000) => new DurableScheduler(container.scheduledJobs, handlers(), { leaseMs });
const count = async (table: string) =>
  Number((await container.db!.execute(sql.raw(`select count(*)::int as n from ${table}`)))[0].n);

beforeAll(async () => {
  container = await buildPostgresContainer(
    TEST_DATABASE_URL,
    undefined,
    loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL: TEST_DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "scheduler-test-key",
      ICOS_REVIEWER_MODEL: "scheduler-test-reviewer",
      ICOS_REVIEWER_TIMEOUT_MS: "1000",
    }),
  );
});

beforeEach(async () => {
  vi.clearAllMocks();
  await container.db!.execute(
    sql.raw("TRUNCATE TABLE scheduled_jobs, missions, tasks, actions, decisions RESTART IDENTITY CASCADE"),
  );
});

afterAll(async () => {
  await container?.db?.execute(
    sql.raw("TRUNCATE TABLE scheduled_jobs, missions, tasks, actions, decisions RESTART IDENTITY CASCADE"),
  );
  await container?.close();
});

const startJob = (key: string, runAt: Date) =>
  container.scheduler.enqueue({
    kind: "start_mission",
    payload: { title: `Mission ${key}`, objective: "Return exactly: OK" },
    idempotencyKey: key,
    runAt,
  });

describe("Durable Scheduler on PostgreSQL — creates a real ICOS Mission", () => {
  it("does not run a future job early, then a due job creates one mission that is planned and dispatched", async () => {
    const { job } = await startJob("future-then-due", new Date(Date.now() + 1_500));
    const scheduler = newScheduler();

    await scheduler.sweep();
    expect(await count("missions")).toBe(0); // too early
    expect((await container.scheduledJobs.getById(job.id))?.state).toBe("scheduled");

    await sleep(1_700);
    const result = await scheduler.sweep();

    expect(result).toMatchObject({ discovered: 1, succeeded: 1, failed: 0 });
    expect(await container.mission.findById(job.missionId!)).toMatchObject({ title: "Mission future-then-due" });
    expect(await container.mission.listTasks(job.missionId!)).toHaveLength(1);
    expect(await count("dispatch_attempts")).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await container.autonomousRuntime.get(job.missionId!)).not.toBeNull();
    expect((await container.scheduledJobs.getById(job.id))?.state).toBe("succeeded");
  });

  it("crash after claim: the job is recovered after lease expiry and creates the mission exactly once", async () => {
    const { job } = await startJob("crash-after-claim", new Date(Date.now() - 1_000));
    await container.scheduledJobs.claimDue("process-that-died", 100);

    expect(await newScheduler().sweep()).toMatchObject({ discovered: 0 }); // lease active
    await sleep(150);
    expect(await newScheduler().sweep()).toMatchObject({ discovered: 1, succeeded: 1 });

    expect(await count("missions")).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await container.scheduledJobs.getById(job.id)).toMatchObject({ state: "succeeded", attemptCount: 2 });
  });

  it("at-least-once safety: re-running the same start_mission job (crash after the mission was created) creates nothing new", async () => {
    const { job } = await startJob("double-execution", new Date(Date.now() - 1_000));
    const h = handlers();
    await h.start_mission(job, { signal: new AbortController().signal });
    await h.start_mission(job, { signal: new AbortController().signal });
    expect(await count("missions")).toBe(1);
    expect(await count("dispatch_attempts")).toBe(1);
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("two concurrent schedulers run 3 due jobs exactly once each", async () => {
    for (const k of ["c1", "c2", "c3"]) await startJob(k, new Date(Date.now() - 1_000));
    const results = await Promise.all([newScheduler().sweep(), newScheduler().sweep()]);
    expect(results.reduce((n, r) => n + r.succeeded, 0)).toBe(3);
    expect(await count("missions")).toBe(3);
    expect(await count("dispatch_attempts")).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("wake_mission wakes an existing mission; a missing mission kills the job without retry", async () => {
    const { job: started } = await startJob("to-wake", new Date(Date.now() - 1_000));
    await newScheduler().sweep();
    const woken = await container.scheduler.enqueue({
      kind: "wake_mission",
      payload: { missionId: started.missionId! },
      idempotencyKey: "wake-1",
      runAt: new Date(Date.now() - 1_000),
    });
    const ghost = await container.scheduler.enqueue({
      kind: "wake_mission",
      payload: { missionId: "ghost-mission" },
      idempotencyKey: "wake-ghost",
      runAt: new Date(Date.now() - 1_000),
    });

    await newScheduler().sweep();

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(started.missionId);
    expect((await container.scheduledJobs.getById(woken.job.id))?.state).toBe("succeeded");
    expect(await container.scheduledJobs.getById(ghost.job.id)).toMatchObject({
      state: "dead",
      lastError: "SCHEDULER_MISSION_NOT_FOUND",
    });
  });
});
