import { describe, expect, it } from "vitest";

import {
  COCKPIT_JOB_CAPACITY,
  COCKPIT_MAX_ITEMS,
  COCKPIT_MAX_TEXT_LENGTH,
  COCKPIT_TERMINAL_TTL_MS,
  CockpitJobCapacityError,
  CockpitJobConflictError,
  CockpitJobRegistry,
  type CreateCockpitJobInput,
} from "./job-registry";

function input(overrides: Partial<CreateCockpitJobInput> = {}): CreateCockpitJobInput {
  return {
    tenantId: "tenant-a",
    idempotencyKey: "request-1",
    objective: "Implement the bounded local task",
    requester: { kind: "human", id: "requester-a" },
    ...overrides,
  };
}

function deterministicRegistry(options: {
  now?: Date;
  capacity?: number;
  terminalTtlMs?: number;
} = {}) {
  let now = options.now ?? new Date("2026-07-29T10:00:00.000Z");
  let sequence = 0;
  return {
    registry: new CockpitJobRegistry({
      clock: () => new Date(now),
      createId: () => `job-${++sequence}`,
      capacity: options.capacity,
      terminalTtlMs: options.terminalTtlMs,
    }),
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("CockpitJobRegistry", () => {
  it("creates a new deterministic queued job", () => {
    const { registry } = deterministicRegistry();
    const result = registry.createOrGet(input());

    expect(result.created).toBe(true);
    expect(result.record).toMatchObject({
      jobId: "job-1",
      status: "QUEUED",
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:00.000Z",
    });
  });

  it("returns the existing record for an exact idempotent replay", () => {
    const { registry } = deterministicRegistry();
    const first = registry.createOrGet(input());
    const replay = registry.createOrGet(input());

    expect(replay).toEqual({ record: first.record, created: false });
  });

  it("rejects reuse of an idempotency key for a different objective", () => {
    const { registry } = deterministicRegistry();
    registry.createOrGet(input());

    expect(() =>
      registry.createOrGet(input({ objective: "A different objective" })),
    ).toThrow(CockpitJobConflictError);
  });

  it("isolates idempotency and lookup by tenant", () => {
    const { registry } = deterministicRegistry();
    const first = registry.createOrGet(input());
    const other = registry.createOrGet(
      input({ tenantId: "tenant-b", requester: { kind: "human", id: "requester-b" } }),
    );

    expect(other.created).toBe(true);
    expect(other.record.jobId).not.toBe(first.record.jobId);
    expect(registry.get("tenant-b", first.record.jobId)).toBeNull();
    expect(registry.get("tenant-a", first.record.jobId)?.jobId).toBe(first.record.jobId);
  });

  it("supports explicit honest state transitions using the injected clock", () => {
    const clock = deterministicRegistry();
    const created = clock.registry.createOrGet(input()).record;
    clock.advance(1_000);
    const running = clock.registry.markRunning("tenant-a", created.jobId);
    clock.advance(2_000);
    const succeeded = clock.registry.markSucceeded("tenant-a", created.jobId, {
      finalResult: "Canonical success",
    });

    expect(running).toMatchObject({
      status: "RUNNING",
      updatedAt: "2026-07-29T10:00:01.000Z",
    });
    expect(succeeded).toMatchObject({
      status: "SUCCEEDED",
      updatedAt: "2026-07-29T10:00:03.000Z",
      completedAt: "2026-07-29T10:00:03.000Z",
    });
    expect(() => clock.registry.markFailed("tenant-a", created.jobId, {
      code: "late",
      message: "late",
    })).toThrow("already terminal");
  });

  it("expires terminal records at the 60 minute TTL", () => {
    const clock = deterministicRegistry();
    const created = clock.registry.createOrGet(input()).record;
    clock.registry.markRunning("tenant-a", created.jobId);
    clock.registry.markSucceeded("tenant-a", created.jobId);

    clock.advance(COCKPIT_TERMINAL_TTL_MS - 1);
    expect(clock.registry.get("tenant-a", created.jobId)).not.toBeNull();
    clock.advance(1);
    expect(clock.registry.get("tenant-a", created.jobId)).toBeNull();
  });

  it("evicts the oldest terminal record first when at capacity", () => {
    const clock = deterministicRegistry({ capacity: 3 });
    const first = clock.registry.createOrGet(input({ idempotencyKey: "one" })).record;
    clock.registry.markRunning("tenant-a", first.jobId);
    clock.registry.markSucceeded("tenant-a", first.jobId);
    clock.advance(1);
    const second = clock.registry.createOrGet(input({ idempotencyKey: "two" })).record;
    clock.registry.markRunning("tenant-a", second.jobId);
    clock.registry.markFailed("tenant-a", second.jobId, { code: "failed", message: "failed" });
    const active = clock.registry.createOrGet(input({ idempotencyKey: "active" })).record;
    clock.registry.markRunning("tenant-a", active.jobId);

    const replacement = clock.registry.createOrGet(input({ idempotencyKey: "four" }));

    expect(replacement.created).toBe(true);
    expect(clock.registry.get("tenant-a", first.jobId)).toBeNull();
    expect(clock.registry.get("tenant-a", second.jobId)).not.toBeNull();
    expect(clock.registry.get("tenant-a", active.jobId)?.status).toBe("RUNNING");
  });

  it("never evicts active jobs and rejects when all 100 records are active", () => {
    const { registry } = deterministicRegistry();
    const activeIds: string[] = [];
    for (let index = 0; index < COCKPIT_JOB_CAPACITY; index++) {
      const created = registry.createOrGet(
        input({ idempotencyKey: `active-${index}` }),
      ).record;
      registry.markRunning("tenant-a", created.jobId);
      activeIds.push(created.jobId);
    }

    expect(() =>
      registry.createOrGet(input({ idempotencyKey: "over-capacity" })),
    ).toThrow(CockpitJobCapacityError);
    expect(activeIds.every((jobId) => registry.get("tenant-a", jobId) !== null)).toBe(true);
  });

  it("bounds failure text and task, blocker, and evidence arrays", () => {
    const { registry } = deterministicRegistry();
    const created = registry.createOrGet(input()).record;
    registry.markRunning("tenant-a", created.jobId);
    const long = "x".repeat(COCKPIT_MAX_TEXT_LENGTH + 100);
    const many = Array.from({ length: COCKPIT_MAX_ITEMS + 10 }, (_, index) => `${index}-${long}`);
    const failed = registry.markFailed(
      "tenant-a",
      created.jobId,
      { code: long, message: long },
      {
        tasks: many.map((label, index) => ({
          taskId: `task-${index}`,
          label,
          status: "FAILED",
        })),
        blockers: many,
        evidence: many,
      },
    );

    expect(failed.sanitizedError?.code).toHaveLength(64);
    expect(failed.sanitizedError?.message).toHaveLength(COCKPIT_MAX_TEXT_LENGTH);
    expect(failed.tasks).toHaveLength(COCKPIT_MAX_ITEMS);
    expect(failed.tasks[0]?.label).toHaveLength(COCKPIT_MAX_TEXT_LENGTH);
    expect(failed.blockers).toHaveLength(COCKPIT_MAX_ITEMS);
    expect(failed.evidence).toHaveLength(COCKPIT_MAX_ITEMS);
  });
});
