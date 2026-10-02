import { describe, expect, it } from "vitest";

import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { SchedulerService } from "@/server/scheduler/scheduler-service";

const service = () => new SchedulerService(new InMemoryScheduledJobRepository());
const start = { title: "Daily report", objective: "Return exactly: OK" };

describe("SchedulerService.enqueue", () => {
  it("fixes the Mission id at enqueue time for start_mission and links the job to it", async () => {
    const { job, created } = await service().enqueue({
      kind: "start_mission",
      payload: start,
      idempotencyKey: "daily-2026-09-19",
    });
    expect(created).toBe(true);
    expect(job.payload).toMatchObject({ ...start, missionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(job.missionId).toBe(job.payload.missionId);
  });

  it("is idempotent for the same key and content (same job, same Mission id) and conflicts otherwise", async () => {
    const s = service();
    const a = await s.enqueue({ kind: "start_mission", payload: start, idempotencyKey: "k" });
    const b = await s.enqueue({ kind: "start_mission", payload: start, idempotencyKey: "k" });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.payload.missionId).toBe(a.job.payload.missionId);
    await expect(
      s.enqueue({ kind: "start_mission", payload: { ...start, objective: "other" }, idempotencyKey: "k" }),
    ).rejects.toThrow("SCHEDULER_IDEMPOTENCY_CONFLICT");
  });

  /* P0-E: l'admission est le point de DÉCLARATION des plafonds d'une mission. */
  it("admits the caps and the compute pool a goal requests, verbatim", async () => {
    const { job } = await service().enqueue({
      kind: "start_mission",
      payload: {
        ...start,
        bounds: { maxRuntimeMs: 1_800_000, maxCycles: 20, maxReplans: 2 },
        computePolicy: { allowedModels: ["cheap-model"] },
      },
      idempotencyKey: "bounded",
    });

    expect(job.payload.bounds).toEqual({ maxRuntimeMs: 1_800_000, maxCycles: 20, maxReplans: 2 });
    expect(job.payload.computePolicy).toEqual({ allowedModels: ["cheap-model"] });
  });

  it("refuses an out-of-contract cap at admission rather than at execution", async () => {
    await expect(
      service().enqueue({
        kind: "start_mission",
        payload: { ...start, bounds: { maxCycles: 0 } },
        idempotencyKey: "k",
      }),
    ).rejects.toThrow("SCHEDULER_INVALID_JOB");
    await expect(
      service().enqueue({
        kind: "start_mission",
        payload: { ...start, bounds: { maxThings: 3 } },
        idempotencyKey: "k",
      }),
    ).rejects.toThrow("SCHEDULER_INVALID_JOB");
  });

  it("schedules wake_mission for an existing mission id", async () => {
    const { job } = await service().enqueue({
      kind: "wake_mission",
      payload: { missionId: "m-1" },
      idempotencyKey: "w",
      runAt: new Date(Date.now() + 60_000),
    });
    expect(job).toMatchObject({ kind: "wake_mission", missionId: "m-1", state: "scheduled" });
  });

  it.each([
    [{ kind: "start_mission", payload: { title: "", objective: "o" }, idempotencyKey: "k" }],
    [{ kind: "start_mission", payload: { ...start, extra: 1 }, idempotencyKey: "k" }],
    [{ kind: "wake_mission", payload: {}, idempotencyKey: "k" }],
    [{ kind: "nope", payload: {}, idempotencyKey: "k" }],
    [{ kind: "wake_mission", payload: { missionId: "m" }, idempotencyKey: "" }],
    [{ kind: "wake_mission", payload: { missionId: "m" }, idempotencyKey: "k", priority: 1000 }],
    [{ kind: "wake_mission", payload: { missionId: "m" }, idempotencyKey: "k", maxAttempts: 0 }],
    [{ kind: "wake_mission", payload: { missionId: "m" }, idempotencyKey: "k", runAt: "not-a-date" }],
    [
      {
        kind: "wake_mission",
        payload: { missionId: "m" },
        idempotencyKey: "k",
        runAt: "2026-09-20T10:00:00Z",
        deadlineAt: "2026-09-20T09:00:00Z",
      },
    ],
  ])("rejects an invalid job %#", async (input) => {
    await expect(service().enqueue(input as never)).rejects.toThrow("SCHEDULER_INVALID_JOB");
  });
});
